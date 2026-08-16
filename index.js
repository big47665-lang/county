require('dotenv').config();
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { hourlyPhrases, counterPhrase, startMessage } = require('./config/phrases');

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
const STEP_MS = 30 * 1000;            // فاصله بین هر پیام شمارشی

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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
