import { config } from '../config.js';
import { getOtpManual } from './manual.js';
import { getOtpFromFile } from './file.js';
import { getOtpFromWebhook } from './webhook-client.js';
import { getOtpFromTelegram } from '../telegram/otp-provider.js';

export async function getOtp({ notBefore } = {}) {
  switch (config.otpProvider) {
    case 'telegram':
      return getOtpFromTelegram({ notBefore, timeoutMs: config.otpTimeoutMs });
    case 'manual':
      return getOtpManual({ timeoutMs: config.otpTimeoutMs });
    case 'file':
      return getOtpFromFile({
        filePath: config.otpFilePath,
        timeoutMs: config.otpTimeoutMs,
        notBefore
      });
    case 'webhook':
      return getOtpFromWebhook({
        baseUrl: config.otpWebhookBaseUrl,
        token: config.otpWebhookToken,
        timeoutMs: config.otpTimeoutMs,
        notBefore
      });
    default:
      throw new Error(`Unknown OTP_PROVIDER: ${config.otpProvider}`);
  }
}
