import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

// ======= Configuration ========
const BOT_TOKEN = "7900951388:AAEBiGs9fCPBgZR6unvA8zcqfvRoR5yxiJw";
const MONGO_URI = "mongodb+srv://p9ks947:Jkg6FSdWBnstOI5w@cluster0.9ftafq6.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const DB_NAME = "chatbotdb";
const APIKEY_COLLECTION = "apikeys";
const HISTORY_COLLECTION = "history";
const ADMIN_ID = 7307633923;
const SITE_URL = "https://your-site.com"; // Optional
const SITE_TITLE = "MyAIChatBot";         // Optional
// ==============================

const bot = new Telegraf(BOT_TOKEN);
const client = new MongoClient(MONGO_URI);

let db, keyCollection, historyCollection;

async function init() {
  await client.connect();
  db = client.db(DB_NAME);
  keyCollection = db.collection(APIKEY_COLLECTION);
  historyCollection = db.collection(HISTORY_COLLECTION);
  scheduleDailyReactivation();
  bot.launch();
}
init();

async function addApiKey(key) {
  await keyCollection.updateOne(
    { key },
    { $set: { key, active: true, added: new Date() } },
    { upsert: true }
  );
}

async function getActiveKeys() {
  return await keyCollection.find({ active: true }).sort({ added: 1 }).toArray();
}

async function disableKey(key) {
  await keyCollection.updateOne({ key }, { $set: { active: false } });
}

async function reactivateAllKeys() {
  try {
    const result = await keyCollection.updateMany({}, { $set: { active: true } });
    console.log(`Reactivated ${result.modifiedCount} API keys.`);
  } catch (error) {
    console.error("Failed to reactivate API keys:", error);
  }
}

function scheduleDailyReactivation() {
  const now = new Date();
  const millisTillMidnight =
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0) - now;

  setTimeout(function () {
    reactivateAllKeys();
    setInterval(reactivateAllKeys, 24 * 60 * 60 * 1000);
  }, millisTillMidnight);
}

async function updateHistory(userId, role, content) {
  const record = await historyCollection.findOne({ _id: userId }) || { messages: [] };
  const updated = [...record.messages, { role, content }];
  const recent = updated.slice(-5);
  await historyCollection.updateOne(
    { _id: userId },
    { $set: { messages: recent } },
    { upsert: true }
  );
}

async function getHistory(userId) {
  const record = await historyCollection.findOne({ _id: userId });
  return record?.messages || [];
}

// Command: /add <API_KEY>
bot.command("add", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("Unauthorized. Admin only.");
  const parts = ctx.message.text.trim().split(" ");
  if (parts.length !== 2) return ctx.reply("Usage: /add <OPENROUTER_API_KEY>");
  await addApiKey(parts[1]);
  ctx.reply("API key has been saved and activated.");
});

// Main logic on user text input
bot.on("text", async (ctx) => {
  const userId = ctx.from.id.toString();
  const userMessage = ctx.message.text;
  const history = await getHistory(userId);
  const fullMessages = [...history, { role: "user", content: userMessage }];
  const apiKeys = await getActiveKeys();

  if (apiKeys.length === 0) return ctx.reply("No working API keys available. Contact admin.");

  let success = false;
  let aiReply = "";

  for (const { key } of apiKeys) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "HTTP-Referer": SITE_URL,
          "X-Title": SITE_TITLE,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "deepseek/deepseek-r1-0528:free",
          messages: fullMessages
        })
      });

      const data = await response.json();

      if (response.ok && data.choices?.[0]?.message?.content) {
        aiReply = data.choices[0].message.content;
        await updateHistory(userId, "user", userMessage);
        await updateHistory(userId, "assistant", aiReply);
        success = true;
        break;
      } else {
        await disableKey(key);
      }
    } catch (error) {
      console.error(`Key failed: ${key}`, error.message);
      await disableKey(key);
    }
  }

  if (success) {
    ctx.reply(aiReply);
  } else {
    ctx.reply("All API keys failed. Contact the admin to add a working one.");
  }
});
