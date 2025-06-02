require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// Configuration from .env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Test message
const testMessage = `
<b>Test Message 📢</b>
This is a test message sent from the Telegram bot to verify connectivity.
Time: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC
`;

// Send the test message
async function sendTestMessage() {
    try {
        await bot.sendMessage(TELEGRAM_CHANNEL_ID, testMessage, { parse_mode: 'HTML' });
        console.log('Test message sent successfully to Telegram channel');
    } catch (error) {
        console.error('Error sending test message:', error.message);
        if (error.code === 429) {
            console.error(`Rate limit hit, retry after ${error.response.parameters.retry_after} seconds`);
        }
    }
}

sendTestMessage();