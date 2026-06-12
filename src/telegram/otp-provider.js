import { config, requireSecret } from '../config.js';
import { extractOtp, isFreshTimestamp } from '../utils/otp.js';
import { sleep } from '../utils/sleep.js';
import { logger } from '../utils/logger.js';
import { TelegramClient } from './client.js';

function messageFromUpdate(update) {
  return update.message ?? update.channel_post ?? null;
}

function messageTimestamp(message) {
  if (!message?.date) return null;
  return new Date(message.date * 1000).toISOString();
}

function chatMatches(message, chatId) {
  if (!chatId) return true;
  return String(message?.chat?.id) === String(chatId);
}

function summarizeMessage(update, message, text) {
  return {
    updateId: update.update_id,
    chatId: message?.chat?.id,
    fromId: message?.from?.id,
    fromIsBot: message?.from?.is_bot,
    receivedAt: messageTimestamp(message),
    extractedOtp: extractOtp(text, config.otpRegex),
    preview: text.slice(0, 120)
  };
}

function timeoutHint() {
  return [
    'Timed out waiting for OTP from Telegram.',
    'If you can see the SMS2Telegram message in Telegram but this script cannot read it, the Android app is probably using your bot token to SEND a message.',
    'Telegram Bot API getUpdates does not return messages sent by the same bot.',
    'Run `npm run telegram:updates` after sending a test OTP to confirm whether Telegram exposes it as an incoming update.',
    'If no OTP update appears there, use the webhook/file provider or an SMS forwarder that can POST to your Node app.'
  ].join(' ');
}

export async function getOtpFromTelegram({
  notBefore,
  timeoutMs = config.otpTimeoutMs,
  dropOldUpdates = config.telegramDropOldUpdates
} = {}) {
  requireSecret('TELEGRAM_CHAT_ID', config.telegramChatId);

  const client = new TelegramClient();
  let offset = null;

  if (dropOldUpdates && !notBefore) {
    offset = await client.dropPendingUpdates();
    logger.info('Cleared old Telegram updates before waiting for fresh OTP');
  }

  const startedAt = Date.now();
  logger.info('Waiting for OTP from Telegram', {
    chatId: config.telegramChatId,
    notBefore: notBefore?.toISOString?.() ?? null,
    timeoutMs
  });

  while (Date.now() - startedAt < timeoutMs) {
    const updates = await client.getUpdates({ offset, timeout: 0 });

    for (const update of updates) {
      offset = update.update_id + 1;
      const message = messageFromUpdate(update);
      if (!message) continue;

      const text = message.text ?? message.caption ?? '';
      const summary = summarizeMessage(update, message, text);

      if (!chatMatches(message, config.telegramChatId)) {
        logger.warn('Telegram update ignored because chat id did not match', summary);
        continue;
      }

      const receivedAt = messageTimestamp(message);
      if (!isFreshTimestamp(receivedAt, notBefore, config.otpFreshnessGraceMs)) {
        logger.warn('Telegram update ignored because it is older than Send OTP click', summary);
        continue;
      }

      const otp = extractOtp(text, config.otpRegex);
      if (otp) {
        logger.info('OTP received from Telegram', { receivedAt });
        return otp;
      }

      logger.warn('Telegram update received but no OTP matched regex', summary);
    }

    await sleep(config.telegramPollIntervalMs);
  }

  throw new Error(timeoutHint());
}
