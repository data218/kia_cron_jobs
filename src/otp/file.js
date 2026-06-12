import fs from 'node:fs/promises';
import { config } from '../config.js';
import { isFreshTimestamp, isOtp } from '../utils/otp.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getOtpFromFile({ filePath, timeoutMs, notBefore }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const payload = JSON.parse(raw);
      const otp = String(payload.otp ?? '').trim();

      if (isOtp(otp) && isFreshTimestamp(payload.receivedAt, notBefore, config.otpFreshnessGraceMs)) {
        return otp;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') {
        throw error;
      }
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for OTP in ${filePath}`);
}
