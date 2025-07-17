const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const express = require('express');

// Start dummy HTTP server to keep Render Web Service alive
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`🌐 HTTP server running on port ${PORT}`));

// Configs
const BOT_TOKEN = '7900951388:AAEBiGs9fCPBgZR6unvA8zcqfvRoR5yxiJw';
const MONGODB_URI = 'mongodb+srv://p9ks947:Jkg6FSdWBnstOI5w@cluster0.9ftafq6.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const ADMIN_ID = 7307633923;

// MongoDB Schemas
const apiKeySchema = new mongoose.Schema({ key: String });
const ApiKey = mongoose.model('ApiKey', apiKeySchema);

const userSchema = new mongoose.Schema({
  userId: Number,
  messages: [{ role: String, content: String }]
});
const UserHistory = mongoose.model('UserHistory', userSchema);

// Bot Setup
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
let apiKeys = [];

(async () => {
  await mongoose.connect(MONGODB_URI);
  const keys = await ApiKey.find();
  apiKeys = keys.map(doc => doc.key);
  console.log('✅ MongoDB connected. API Keys loaded.');
})();

// Retry-enabled OpenRouter API Call
async function queryOpenRouter(messages) {
  let lastError;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'deepseek/deepseek-r1-0528:free',
            messages: messages
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://your-site.com',
              'X-Title': 'Telegram AI Bot'
            },
            timeout: 30000
          }
        );
        return response.data.choices[0].message.content;
      } catch (error) {
        lastError = error;
        console.warn(`API Key ${i + 1} attempt ${attempt} failed: ${error.message}`);
        await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(`All API keys failed. Last error: ${lastError.message}`);
}

// Add API Key (Admin only)
bot.onText(/\/add (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  const newKey = match[1].trim();
  if (apiKeys.includes(newKey)) {
    return bot.sendMessage(msg.chat.id, '⚠️ API key already exists.');
  }
  await ApiKey.create({ key: newKey });
  apiKeys.push(newKey);
  bot.sendMessage(msg.chat.id, '✅ API key added and stored.');
});

// Handle user messages
bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const userId = msg.from.id;
  const userMessage = msg.text;

  try {
    let history = await UserHistory.findOne({ userId });
    if (!history) {
      history = await UserHistory.create({ userId, messages: [] });
    }

    history.messages.push({ role: 'user', content: userMessage });
    if (history.messages.length > 10) {
      history.messages = history.messages.slice(-10);
    }

    const reply = await queryOpenRouter(history.messages);
    history.messages.push({ role: 'assistant', content: reply });
    if (history.messages.length > 10) {
      history.messages = history.messages.slice(-10);
    }

    await history.save();
    bot.sendMessage(msg.chat.id, reply);
  } catch (err) {
    console.error('❌ Error:', err.message);
    bot.sendMessage(msg.chat.id, '⚠️ Failed to get response. Try again later.');
  }
});
