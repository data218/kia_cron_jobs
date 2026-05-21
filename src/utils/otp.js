export function extractOtp(text, pattern = /\d{4,6}/) {
  const match = String(text ?? '').match(pattern);
  return match?.[0] ?? null;
}

export function isOtp(value) {
  return /^\d{4,8}$/.test(String(value ?? '').trim());
}

export function isFreshTimestamp(value, notBefore) {
  if (!notBefore) return true;
  if (!value) return false;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= notBefore.getTime();
}
