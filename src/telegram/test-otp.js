import { TelegramClient } from './client.js';
import { getOtpFromTelegram } from './otp-provider.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const client = new TelegramClient();
const bot = await client.getMe();
logger.info('Telegram bot connected', { username: bot.username, id: bot.id });
logger.info('Send a test message containing a 4-6 digit OTP to the bot now', {
  timeoutMs: config.otpTimeoutMs
});

const otp = await getOtpFromTelegram({ notBefore: new Date() });
logger.info('Telegram OTP test succeeded', { otp });
