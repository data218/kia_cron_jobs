import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isFreshTimestamp, isOtp } from '../utils/otp.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getOtpFromWebhook({ baseUrl, token, timeoutMs, notBefore, purpose }) {
  const startedAt = Date.now();
  const url = new URL('/otp/latest', baseUrl);
  if (purpose) {
    url.searchParams.set('purpose', purpose);
  }
  const fallbackUrl = purpose === 'kia' ? new URL('/otp/latest', baseUrl) : null;
  if (fallbackUrl) {
    fallbackUrl.searchParams.set('purpose', 'unknown');
  }
  let lastRejectedOtpTimestamp = null;
  let lastRejectedFallbackOtpTimestamp = null;

  async function readOtp(candidateUrl, { isFallback = false } = {}) {
    const response = await fetch(candidateUrl, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const otp = String(payload.otp ?? '').trim();
    if (!isOtp(otp)) {
      return null;
    }

    if (isFreshTimestamp(payload.receivedAt, notBefore, config.otpFreshnessGraceMs)) {
      if (isFallback) {
        logger.warn('Using fresh unknown-purpose OTP for active KIA request', {
          purpose,
          receivedAt: payload.receivedAt,
          notBefore: notBefore?.toISOString?.()
        });
      }
      return otp;
    }

    const rejectedKey = isFallback ? 'fallback' : 'primary';
    const previousTimestamp = isFallback ? lastRejectedFallbackOtpTimestamp : lastRejectedOtpTimestamp;
    if (payload.receivedAt !== previousTimestamp) {
      if (isFallback) {
        lastRejectedFallbackOtpTimestamp = payload.receivedAt;
      } else {
        lastRejectedOtpTimestamp = payload.receivedAt;
      }

      logger.warn('Webhook OTP received but ignored because it is older than current OTP request window', {
        purpose: isFallback ? 'unknown' : purpose,
        requestedPurpose: purpose,
        rejectedKey,
        receivedAt: payload.receivedAt,
        notBefore: notBefore?.toISOString?.(),
        freshnessGraceMs: config.otpFreshnessGraceMs
      });
    }

    return null;
  }

  while (Date.now() - startedAt < timeoutMs) {
    const otp = await readOtp(url);
    if (otp) {
      return otp;
    }

    if (fallbackUrl) {
      const fallbackOtp = await readOtp(fallbackUrl, { isFallback: true });
      if (fallbackOtp) {
        return fallbackOtp;
      }
    }

    await sleep(500);
  }

  throw new Error('Timed out waiting for OTP from webhook service');
}
