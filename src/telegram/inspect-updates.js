import { TelegramClient } from './client.js';
import { extractOtp } from '../utils/otp.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

function messageFromUpdate(update) {
  return update.message ?? update.channel_post ?? null;
}

function summarize(update) {
  const message = messageFromUpdate(update);
  const text = message?.text ?? message?.caption ?? '';

  return {
    updateId: update.update_id,
    chatId: message?.chat?.id,
    chatType: message?.chat?.type,
    fromId: message?.from?.id,
    fromIsBot: message?.from?.is_bot,
    date: message?.date ? new Date(message.date * 1000).toISOString() : null,
    text,
    extractedOtp: extractOtp(text, config.otpRegex)
  };
}

const client = new TelegramClient();
const bot = await client.getMe();
logger.info('Telegram bot connected', { username: bot.username, id: bot.id });

const updates = await client.getUpdates({ timeout: 0 });

if (!updates.length) {
  logger.warn('No pending Telegram updates are visible to this bot');
  logger.info('Send a normal message directly TO the bot, then run `npm run telegram:updates` again');
  logger.info('If Telegram shows the SMS forwarded by Android but no update appears here, the message was likely sent BY the bot and cannot be read with Bot API polling');
} else {
  logger.info('Visible Telegram updates', { count: updates.length });
  for (const update of updates.slice(-10)) {
    logger.info('Update', summarize(update));
  }
}
