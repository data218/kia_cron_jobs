import path from 'node:path';
import { config } from '../config.js';
import { createGdmsAccountProfile } from './gdms-account-profile.js';

const RAJOURI_HISTORICAL_FETCH_CODE = 'N6824';

function sessionPathForUser(userId, defaultPath) {
  const normalized = String(userId || 'unknown').trim().toUpperCase();
  const dir = path.dirname(defaultPath);
  const base = path.basename(defaultPath, '.json');
  return path.join(dir, `${base}-${normalized}.json`);
}

export function resolveAmPlatinumSessionStatePath(accountKey = 'current') {
  if (accountKey === 'historical') {
    return sessionPathForUser(
      config.amPlatinumHistoricalUserId,
      config.amPlatinumHistoricalSessionStatePath
    );
  }

  return sessionPathForUser(
    config.amPlatinumUserId,
    config.amPlatinumSessionStatePath
  );
}

export function listAmPlatinumSessionCachePaths() {
  const paths = new Set([
    config.amPlatinumSessionStatePath,
    config.amPlatinumHistoricalSessionStatePath,
    resolveAmPlatinumSessionStatePath('current'),
    resolveAmPlatinumSessionStatePath('historical')
  ]);

  return [...paths];
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function normalizeDealerCode(dealerCode) {
  return String(dealerCode || '').trim().toUpperCase();
}

function rajouriStoredDealerCode() {
  return config.amPlatinumPost2024DealerCode || 'N6250';
}

function rajouriMis1988StartDate() {
  return config.amPlatinumRajouriMis1988StartDate
    || config.amPlatinumHistoricalCutoffDate
    || '2024-01-01';
}

function isRajouriTarget(dealerCode) {
  const code = normalizeDealerCode(dealerCode);
  return code === RAJOURI_HISTORICAL_FETCH_CODE || code === rajouriStoredDealerCode();
}

export function normalizeRajouriDealerCode(dealerCode) {
  return isRajouriTarget(dealerCode) ? rajouriStoredDealerCode() : normalizeDealerCode(dealerCode);
}

function usesAmPlatinumHistoricalLoginOnly(dealerCode) {
  const code = normalizeDealerCode(dealerCode);
  return code === 'N5211' || code === 'N6828';
}

export function resolveAmPlatinumAccountKeyForRange(range, targetDealerCode = null) {
  const startIso = range?.startIso ?? range?.startDate;
  if (!startIso) {
    return 'current';
  }

  const start = String(startIso);
  const cutoff = config.amPlatinumHistoricalCutoffDate || '2024-03-01';
  const dealerCode = targetDealerCode ? normalizeDealerCode(targetDealerCode) : null;

  if (dealerCode && usesAmPlatinumHistoricalLoginOnly(dealerCode)) {
    return 'historical';
  }

  if (dealerCode && isRajouriTarget(dealerCode)) {
    return start >= rajouriMis1988StartDate() ? 'current' : 'historical';
  }

  return start >= cutoff ? 'current' : 'historical';
}

export function resolveAmPlatinumLoginUserIdForRange(targetDealerCode, range) {
  const accountKey = resolveAmPlatinumAccountKeyForRange(range, targetDealerCode);
  return accountKey === 'current'
    ? (config.amPlatinumUserId || 'MIS1988')
    : (config.amPlatinumHistoricalUserId || 'MIS12345');
}

export function resolveAmPlatinumDealerForFetch(targetDealerCode, range) {
  const dealerCode = normalizeDealerCode(targetDealerCode);
  const accountKey = resolveAmPlatinumAccountKeyForRange(range, dealerCode);

  if (isRajouriTarget(dealerCode)) {
    if (accountKey === 'current') {
      return rajouriStoredDealerCode();
    }

    return RAJOURI_HISTORICAL_FETCH_CODE;
  }

  return dealerCode;
}

export function resolveAmPlatinumSourceDealerCode(targetDealerCode, range) {
  const dealerCode = normalizeDealerCode(targetDealerCode);

  if (isRajouriTarget(dealerCode)) {
    return rajouriStoredDealerCode();
  }

  return dealerCode;
}

export function resolveAmPlatinumStoredDealerCodesForSkipCheck(targetDealerCode, range) {
  const dealerCode = normalizeDealerCode(targetDealerCode);

  if (isRajouriTarget(dealerCode)) {
    const storedCode = rajouriStoredDealerCode();
    return storedCode === dealerCode
      ? [storedCode, RAJOURI_HISTORICAL_FETCH_CODE]
      : [storedCode, RAJOURI_HISTORICAL_FETCH_CODE, dealerCode];
  }

  return [dealerCode];
}

export function shouldSkipAmPlatinumRangeForDealer(targetDealerCode, range) {
  const dealerCode = normalizeDealerCode(targetDealerCode);
  const accountKey = resolveAmPlatinumAccountKeyForRange(range, dealerCode);
  const startIso = String(range?.startIso ?? range?.startDate ?? '');

  // MIS1988 cannot serve N5211/N6828 (always MIS12345).
  if (accountKey === 'current' && !isRajouriTarget(dealerCode)) {
    return true;
  }

  // MIS12345 cannot serve post-2024 Rajouri ranges (need MIS1988 + N6250 fetch).
  if (accountKey === 'historical' && isRajouriTarget(dealerCode) && startIso >= rajouriMis1988StartDate()) {
    return true;
  }

  return false;
}

export function createAmPlatinumAccount(accountKey = 'current') {
  const base = createGdmsAccountProfile('am-platinum');

  if (accountKey === 'historical') {
    return {
      ...base,
      id: 'am-platinum-historical',
      displayName: config.amPlatinumHistoricalUserId || 'historical',
      logPrefix: `AM Platinum ${config.amPlatinumHistoricalUserId || 'historical'}`,
      userId: config.amPlatinumHistoricalUserId,
      password: config.amPlatinumHistoricalPassword,
      userIdEnvName: 'AM_PLATINUM_HISTORICAL_USER_ID',
      passwordEnvName: 'AM_PLATINUM_HISTORICAL_PASSWORD',
      sessionStatePath: resolveAmPlatinumSessionStatePath('historical')
    };
  }

  return {
    ...base,
    id: 'am-platinum',
    displayName: config.amPlatinumUserId || 'current',
    logPrefix: `AM Platinum ${config.amPlatinumUserId || 'current'}`,
    sessionStatePath: resolveAmPlatinumSessionStatePath('current')
  };
}

export function applyHistoricalRunOptions(account) {
  return {
    ...account,
    headless: process.env.AM_PLATINUM_HISTORICAL_HEADLESS != null
      && process.env.AM_PLATINUM_HISTORICAL_HEADLESS !== ''
      ? envBool('AM_PLATINUM_HISTORICAL_HEADLESS', false)
      : envBool('HEADLESS', false),
    forceLogin: envBool('AM_PLATINUM_FORCE_LOGIN', config.amPlatinumForceLogin)
      || envBool('AM_PLATINUM_HISTORICAL_FORCE_LOGIN', false),
    otpProvider: process.env.AM_PLATINUM_HISTORICAL_OTP_PROVIDER
      || config.amPlatinumHistoricalOtpProvider
      || 'manual'
  };
}

export function createAmPlatinumAccountForRange(range, targetDealerCode = null) {
  const accountKey = resolveAmPlatinumAccountKeyForRange(range, targetDealerCode);
  return {
    accountKey,
    account: applyHistoricalRunOptions(createAmPlatinumAccount(accountKey))
  };
}

export function describeAmPlatinumLoginPlan(startDate, endDate, dealerCodes = []) {
  const rajouriStart = rajouriMis1988StartDate();
  const cutoff = config.amPlatinumHistoricalCutoffDate || '2024-03-01';
  const dealers = dealerCodes.map(normalizeDealerCode).filter(Boolean);
  const hasRajouri = dealers.some(isRajouriTarget);
  const onlyRajouri = dealers.length > 0 && dealers.every(isRajouriTarget);
  const start = String(startDate || '');
  const end = String(endDate || '');

  if (onlyRajouri && start >= rajouriStart) {
    return `Rajouri run ${start} to ${end}: MIS1988 (${config.amPlatinumUserId}) only — dealer ${rajouriStoredDealerCode()}`;
  }

  if (hasRajouri) {
    return `Mixed dealers ${start} to ${end}: Rajouri uses MIS1988 from ${rajouriStart}; other dealers use MIS12345 before ${cutoff}`;
  }

  if (start >= cutoff) {
    return `Run ${start} to ${end}: MIS12345 for N5211/N6828; MIS1988 for Rajouri from ${rajouriStart}`;
  }

  return `Run ${start} to ${end}: MIS12345 before ${cutoff}, MIS1988 from ${cutoff} for Rajouri only`;
}
