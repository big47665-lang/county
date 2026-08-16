require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const {
  hourlyPhrases,
  counterPhrase,
  startMessage,
  dartChooseCountMessage,
  dartWaitingMessage,
  dartThrowResultMessage,
  dartWinnerMessage,
  dartRoundsPerPlayer,
} = require('./config/phrases');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('خطا: متغیر محیطی BOT_TOKEN تنظیم نشده. توکن بات رو از BotFather بگیر و توی .env یا Railway variables بذار.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- ذخیره‌سازی ساده روی فایل (گروه‌ها + کول‌داون هر کاربر) ----------
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { groups: [], cooldowns: {} };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
let data = loadData();

// نکته: روی Railway بدون volume دائمی، این فایل بعد از هر ری‌استارت پاک میشه.
// اگه می‌خوای گروه‌ها و کول‌داون‌ها دائمی بمونن، یه Volume به سرویس Railway اضافه کن
// و DATA_FILE رو به مسیر اون volume اشاره بده.

const MAX_COUNT = 25;                 // حداکثر عدد قابل قبول برای /count
const COOLDOWN_MS = 30 * 60 * 1000;   // 30 دقیقه فاصله بین دو استفاده هر کاربر
const STEP_MS = 2.5 * 1000;            // فاصله بین هر پیام شمارشی

// ---------- /start ----------
bot.start((ctx) => {
  if (ctx.chat.type === 'private') {
    ctx.reply(startMessage);
  }
});

// ---------- ردیابی گروه‌هایی که بات توشون عضوه (برای پیام ساعتی) ----------
bot.on('my_chat_member', (ctx) => {
  const chat = ctx.chat;
  const newStatus = ctx.update.my_chat_member.new_chat_member.status;

  if (['member', 'administrator'].includes(newStatus)) {
    if (!data.groups.includes(chat.id)) {
      data.groups.push(chat.id);
      saveData(data);
      console.log(`بات به گروه اضافه شد: ${chat.id} (${chat.title || ''})`);
    }
  } else if (['left', 'kicked'].includes(newStatus)) {
    data.groups = data.groups.filter((id) => id !== chat.id);
    saveData(data);
    console.log(`بات از گروه حذف شد: ${chat.id}`);
  }
});

// ---------- دستور شمارشگر ----------
bot.command('count', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('این دستور فقط داخل گروه کار می‌کنه.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  const requested = parseInt(args[0], 10);

  if (!requested || requested < 1) {
    return ctx.reply(`لطفاً یک عدد بعد از دستور بنویس. مثال:\n/count 10\n(حداکثر ${MAX_COUNT})`);
  }

  const target = Math.min(requested, MAX_COUNT);

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const last = data.cooldowns[key] || 0;

  if (now - last < COOLDOWN_MS) {
    const remainingMin = Math.ceil((COOLDOWN_MS - (now - last)) / 60000);
    return ctx.reply(`صبر کن! ${remainingMin} دقیقه دیگه می‌تونی دوباره از این دستور استفاده کنی.`);
  }

  data.cooldowns[key] = now;
  saveData(data);

  let i = 1;
  const sendNext = async () => {
    try {
      await ctx.reply(`${i} ${counterPhrase}`);
    } catch (e) {
      console.error('خطا در ارسال پیام شمارشی:', e.message);
      return; // اگه ارسال خطا داد ادامه ندیم
    }
    if (i < target) {
      i++;
      setTimeout(sendNext, STEP_MS);
    }
  };
  sendNext();
});

// ---------- بازی دارت ----------
// وضعیت بازی‌های در حال اجرا، فقط توی حافظه (با ری‌استارت بات پاک میشه)
// کلید = آیدی گروه، مقدار = { maxPlayers, players: { userId: { name, score, throws } }, order: [userId,...] }
const dartGames = {};

function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? vars[key] : `{${key}}`));
}

bot.command('dart', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('این دستور فقط داخل گروه کار می‌کنه.');
  }
  return ctx.reply(
    dartChooseCountMessage,
    Markup.inlineKeyboard([
      Markup.button.callback('2 نفر', 'dart_start_2'),
      Markup.button.callback('3 نفر', 'dart_start_3'),
      Markup.button.callback('4 نفر', 'dart_start_4'),
    ])
  );
});

bot.action(/dart_start_(\d)/, async (ctx) => {
  const maxPlayers = parseInt(ctx.match[1], 10);
  const chatId = ctx.chat.id;

  dartGames[chatId] = {
    maxPlayers,
    players: {},
    order: [],
  };

  await ctx.answerCbQuery();
  await ctx.editMessageText(fillTemplate(dartWaitingMessage, { max: maxPlayers }));
});

// وقتی یه نفر خودش ایموجی 🎯 رو بفرسته، تلگرام خودش انیمیشن رو نشون میده
// و نتیجه (عدد ۱ تا ۶) رو توی همون پیام برای بات می‌فرسته
bot.on('message', async (ctx, next) => {
  const dice = ctx.message && ctx.message.dice;
  if (!dice || dice.emoji !== '🎯') {
    return next();
  }

  const chatId = ctx.chat.id;
  const game = dartGames[chatId];
  if (!game) {
    return; // بازی فعالی توی این گروه نیست، نادیده بگیر
  }

  const userId = ctx.from.id;
  const playerName = ctx.from.first_name || ctx.from.username || 'بازیکن';

  // اگه بازیکن جدیده و هنوز جا هست، ثبتش کن
  if (!game.players[userId]) {
    if (Object.keys(game.players).length >= game.maxPlayers) {
      return; // بازی پره، این پرتاب حساب نمیشه
    }
    game.players[userId] = { name: playerName, score: 0, throws: 0 };
    game.order.push(userId);
  }

  const player = game.players[userId];
  if (player.throws >= dartRoundsPerPlayer) {
    return; // این بازیکن نوبتش تموم شده
  }

  player.throws += 1;
  player.score += dice.value;

  await ctx.reply(
    fillTemplate(dartThrowResultMessage, {
      player: player.name,
      points: dice.value,
      total: player.score,
    })
  );

  const allPlayersFull = Object.keys(game.players).length >= game.maxPlayers;
  const everyoneFinished = allPlayersFull && game.order.every((id) => game.players[id].throws >= dartRoundsPerPlayer);

  if (everyoneFinished) {
    let winnerId = game.order[0];
    for (const id of game.order) {
      if (game.players[id].score > game.players[winnerId].score) {
        winnerId = id;
      }
    }
    const winner = game.players[winnerId];

    await ctx.reply(fillTemplate(dartWinnerMessage, { player: winner.name, total: winner.score }));
    delete dartGames[chatId];
  }
});

// ---------- پیام خودکار ساعتی ----------
// هر ساعت راس دقیقه صفر اجرا میشه: 0 * * * *
cron.schedule('0 * * * *', async () => {
  const hour = new Date().getHours(); // 0 تا 23 بر اساس ساعت سرور
  const options = hourlyPhrases[hour];
  if (!options || options.length === 0) return;

  const phrase = options[Math.floor(Math.random() * options.length)];

  for (const groupId of data.groups) {
    try {
      await bot.telegram.sendMessage(groupId, phrase);
    } catch (e) {
      console.error(`ارسال به گروه ${groupId} ناموفق بود:`, e.message);
    }
  }
});

bot.launch();
console.log('بات با موفقیت اجرا شد.');

// این لیست باعث میشه دستورات توی باکس / کنار پیام تلگرام نشون داده بشن
bot.telegram.setMyCommands([
  { command: 'start', description: 'شروع و راهنما' },
  { command: 'count', description: 'شمارش تا یک عدد دلخواه (حداکثر 25)' },
  { command: 'dart', description: 'شروع بازی دارت' },
]).then(() => {
  console.log('لیست دستورات با موفقیت ثبت شد.');
}).catch((e) => {
  console.error('خطا در ثبت لیست دستورات:', e.message);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
