const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const express = require('express');
const os = require('os');

// ====== Express Server for Render Health Check ======
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// ====== Restart Every 30 Minutes ======
setTimeout(() => {
  console.log('🕒 Restarting due to timeout...');
  process.exit(1);
}, 30 * 60 * 1000);

// ====== Memory Monitor ======
const MEMORY_THRESHOLD = 60; // %
setInterval(() => {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = ((total - free) / total) * 100;
  if (usedPercent > MEMORY_THRESHOLD) {
    console.log('🚨 Memory usage high, restarting...');
    process.exit(1);
  }
}, 30000);

// ====== Configurations ======
const BOT_TOKEN = '7900951388:AAE-5qbp76wWGmfByzbkruhscytGRWJqmt0';
const MONGO_URI = 'mongodb+srv://p9ks947:Jkg6FSdWBnstOI5w@cluster0.9ftafq6.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const ADMIN_ID = 7307633923; // Replace with your Telegram user ID

// ====== MongoDB Schemas ======
const apiKeySchema = new mongoose.Schema({ key: String });
const ApiKey = mongoose.model('ApiKey', apiKeySchema);

const userSchema = new mongoose.Schema({
  userId: Number,
  messages: [{ role: String, content: String }]
});
const User = mongoose.model('User', userSchema);

// ====== Start Bot ======
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
let apiKeys = [];

(async () => {
  await mongoose.connect(MONGO_URI);
  const keys = await ApiKey.find();
  apiKeys = keys.map(k => k.key);
  console.log(`✅ Connected to MongoDB. Loaded ${apiKeys.length} API keys.`);
})();

// ====== Gemini API Call with Retry & Auto-Key Removal ======
async function queryGemini(messages) {
  const systemMessage = { role: 'user', content: 'Your name is Kaustav Ray. Made and running in Sonarpur.' };
  const fullMessages = [systemMessage, ...messages];

  let lastError;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
          {
            contents: [{
              role: "user",
              parts: fullMessages.map(m => ({ text: m.content }))
            }]
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
          }
        );

        const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!reply) throw new Error('Empty reply from Gemini');
        return reply;

      } catch (err) {
        lastError = err;
        console.warn(`⚠️ API key failed: ${apiKey} | Attempt ${attempt} | ${err.message}`);
        if (attempt === 3) {
          await ApiKey.deleteOne({ key: apiKey });
          apiKeys.splice(i, 1);
          i--;
          console.log(`🗑️ Removed bad API key: ${apiKey}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
  }

  throw new Error(`❌ All API keys failed. Last error: ${lastError?.message}`);
}

// ====== Add Gemini API Key via /add Command ======
bot.onText(/\/add (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const newKey = match[1].trim();
  if (apiKeys.includes(newKey)) return bot.sendMessage(msg.chat.id, '⚠️ Already added.');

  await ApiKey.create({ key: newKey });
  apiKeys.push(newKey);
  bot.sendMessage(msg.chat.id, '✅ Gemini API key added.');
});

// ====== Handle User Messages ======
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  try {
    let user = await User.findOne({ userId });
    if (!user) user = await User.create({ userId, messages: [] });

    user.messages.push({ role: 'user', content: text });
    if (user.messages.length > 10) user.messages = user.messages.slice(-10);

    const response = await queryGemini(user.messages);
    user.messages.push({ role: 'assistant', content: response });
    if (user.messages.length > 10) user.messages = user.messages.slice(-10);

    await user.save();

    // Typing effect simulation
    const words = response.split(' ');
    let output = '';
    const sent = await bot.sendMessage(chatId, '✍️');
    const msgId = sent.message_id;

    for (const word of words) {
      output += word + ' ';
      try {
        await bot.editMessageText(output, { chat_id: chatId, message_id: msgId });
        await new Promise(r => setTimeout(r, 80));
      } catch (e) {
        if (e.response?.body?.description?.includes('message is not modified')) continue;
        console.error('❗Edit failed:', e.message);
      }
    }

  } catch (err) {
    console.error('❌', err.message);
    bot.sendMessage(chatId, '⚠️ Sorry, all API keys failed. Try again later.');
  }
});
