import { isFreshTimestamp, isOtp } from '../utils/otp.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getOtpFromWebhook({ baseUrl, token, timeoutMs, notBefore }) {
  const startedAt = Date.now();
  const url = new URL('/otp/latest', baseUrl);

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    if (response.ok) {
      const payload = await response.json();
      const otp = String(payload.otp ?? '').trim();
      if (isOtp(otp) && isFreshTimestamp(payload.receivedAt, notBefore)) {
        return otp;
      }
    }

    await sleep(2000);
  }

  throw new Error('Timed out waiting for OTP from webhook service');
}
