function capturedOrFullMatch(match) {
  if (!match) return null;
  return match.find((value, index) => index > 0 && isOtp(value)) ?? match[0];
}

export function extractOtp(text, pattern = /\d{4,6}/) {
  const value = String(text ?? '');

  const priorityPatterns = [
    /\b(?:otp|one\s*time\s*password|password)\b[\s\S]{0,80}?\b(?:is|:|-)?\s*(\d{4,8})\b/i,
    /\b(?:gdms|hyundai|mobile\s+number\s+authentication)\b[\s\S]{0,120}?\b(\d{4,8})\b/i,
    /\b(\d{4,8})\b[\s\S]{0,80}?\b(?:otp|one\s*time\s*password|gdms|hyundai)\b/i
  ];

  for (const candidatePattern of priorityPatterns) {
    const otp = capturedOrFullMatch(value.match(candidatePattern));
    if (isOtp(otp)) {
      return otp;
    }
  }

  const fallback = capturedOrFullMatch(value.match(pattern));
  return isOtp(fallback) ? fallback : null;
}

export function isOtp(value) {
  return /^\d{4,8}$/.test(String(value ?? '').trim());
}

export function isFreshTimestamp(value, notBefore, graceMs = 0) {
  if (!notBefore) return true;
  if (!value) return false;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp + graceMs >= notBefore.getTime();
}
