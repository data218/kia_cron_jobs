import path from 'node:path';
import { config, requireSecret } from '../config.js';

/**
 * Logins for the HIIB insurance portal (ha.hiib.in). Each portal login is locked
 * server-side to one dealer, so a dealer is covered by adding its account here
 * rather than by selecting a dealer in the UI.
 */
const ACCOUNTS = {
  hiib: {
    id: 'hiib',
    label: 'HIIB N5203 (AM Hyundai)',
    dealerCode: 'N5203',
    userIdKey: 'HIIB_USER_ID',
    passwordKey: 'HIIB_PASSWORD',
    userId: () => config.hiibUserId,
    password: () => config.hiibPassword,
    sessionStatePath: () => config.hiibSessionStatePath,
    sheetName: () => config.hyundaiInsuranceReportSheetName
  },
  platinum: {
    id: 'platinum',
    label: 'HIIB N5211 (AM Platinum)',
    dealerCode: 'N5211',
    userIdKey: 'HIIB_PLATINUM_USER_ID',
    passwordKey: 'HIIB_PLATINUM_PASSWORD',
    userId: () => config.hiibPlatinumUserId,
    password: () => config.hiibPlatinumPassword,
    sessionStatePath: () => config.hiibPlatinumSessionStatePath,
    sheetName: () => config.hiibPlatinumSheetName
  }
};

export function listHiibAccountIds() {
  return Object.keys(ACCOUNTS);
}

/**
 * Builds the account profile consumed by loginToHiibPortal and the report module.
 * Throws if the account's credentials are missing from .env.
 */
export function createHiibAccountProfile(accountId = 'hiib') {
  const key = String(accountId || 'hiib').trim().toLowerCase();
  const definition = ACCOUNTS[key];

  if (!definition) {
    throw new Error(
      `Unknown HIIB account "${accountId}". Known accounts: ${listHiibAccountIds().join(', ')}`
    );
  }

  const userId = definition.userId();
  const password = definition.password();

  requireSecret(definition.userIdKey, userId);
  requireSecret(definition.passwordKey, password);

  return Object.freeze({
    id: definition.id,
    label: definition.label,
    dealerCode: definition.dealerCode,
    userId,
    password,
    sheetName: definition.sheetName(),
    sessionStatePath: definition.sessionStatePath(),
    // Kept per-account so concurrent runs never share a download directory.
    downloadDir: path.join(config.hiibDownloadDir, definition.id),
    reportChunksDir: path.join(config.hiibReportChunksDir, definition.id)
  });
}
