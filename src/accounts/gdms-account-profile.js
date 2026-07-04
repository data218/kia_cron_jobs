import { config } from '../config.js';
import path from 'path';

function prefixSheetName(account, sheetName) {
  if (!account.sheetPrefix) return sheetName;

  const cleaned = String(sheetName)
    .replace(/^Hyundai\s+/i, '')
    .replace(/^trust_package$/i, 'Trust Package')
    .trim();

  return `${account.sheetPrefix} ${cleaned}`;
}

function hmilProfile() {
  return {
    id: 'hmil',
    brand: 'hyundai',
    displayName: 'HMIL',
    serviceName: 'hmil-cron-job',
    systemLabel: 'HMIL DMS',
    logPrefix: 'HMIL',
    defaultMode: 'hyundai-regular',
    cronSchedule: config.hmilCronSchedule,
    currentMonthOnly: config.hmilCurrentMonthOnly,
    loginUrl: config.hmilLoginUrl,
    homeUrl: config.hmilHomeUrl,
    userId: config.hmilUserId,
    password: config.hmilPassword,
    userIdEnvName: 'HMIL_USER_ID',
    passwordEnvName: 'HMIL_PASSWORD',
    forceLogin: config.hmilForceLogin,
    loginRetries: config.hmilLoginRetries,
    sessionCheckTimeoutMs: config.hmilSessionCheckTimeoutMs,
    sessionStatePath: config.hmilSessionStatePath,
    downloadDir: config.hmilDownloadDir,
    reportChunksDir: config.hmilReportChunksDir,
    dealerCodes: config.hmilPrimaryDealerCodes,
    reportsToRun: config.hmilReportsToRun,
    headless: config.headless,
    repairOrderSheetName: config.hmilRepairOrderSheetName,
    repairOrderPageSize: config.hmilRepairOrderPageSize,
    repairOrderUseActiveDealerOnly: config.hmilRepairOrderUseActiveDealerOnly,
    repairOrderStartDate: config.hmilPrimaryRepairOrderStartDate,
    repairOrderEndDate: config.hmilPrimaryRepairOrderEndDate,
    repairOrderPostSearchDelayMs: config.hmilRepairOrderPostSearchDelayMs,
    healthFileName: 'hmil-health.json',
    otpPurpose: 'hmil',
    sheetName: sheetName => prefixSheetName({ sheetPrefix: '' }, sheetName)
  };
}

function amPlatinumProfile() {
  return {
    id: 'am-platinum',
    brand: 'am_platinum',
    displayName: 'AM Platinum',
    serviceName: 'am-platinum-cron-job',
    systemLabel: 'AM Platinum GDMS',
    logPrefix: 'AM Platinum',
    defaultMode: 'am-platinum-regular',
    cronSchedule: config.amPlatinumCronSchedule,
    cronTimezone: config.amPlatinumCronTimezone,
    currentMonthOnly: config.amPlatinumCurrentMonthOnly,
    loginUrl: config.amPlatinumLoginUrl,
    homeUrl: config.amPlatinumHomeUrl,
    userId: config.amPlatinumUserId,
    password: config.amPlatinumPassword,
    userIdEnvName: 'AM_PLATINUM_USER_ID',
    passwordEnvName: 'AM_PLATINUM_PASSWORD',
    forceLogin: config.amPlatinumForceLogin,
    loginRetries: config.amPlatinumLoginRetries,
    sessionCheckTimeoutMs: config.amPlatinumSessionCheckTimeoutMs,
    sessionStatePath: config.amPlatinumSessionStatePath,
    downloadDir: config.amPlatinumDownloadDir,
    reportChunksDir: config.amPlatinumReportChunksDir,
    dealerCodes: config.amPlatinumDealerCodes,
    reportsToRun: config.amPlatinumReportsToRun,
    headless: config.headless,
    repairOrderSheetName: config.amPlatinumRepairOrderSheetName,
    repairOrderPageSize: config.amPlatinumRepairOrderPageSize,
    repairOrderUseActiveDealerOnly: false,
    repairOrderStartDate: config.amPlatinumRepairOrderStartDate,
    repairOrderEndDate: config.amPlatinumRepairOrderEndDate,
    repairOrderPostSearchDelayMs: config.amPlatinumRepairOrderPostSearchDelayMs,
    healthFileName: 'am-platinum-health.json',
    otpPurpose: 'hmil',
    sheetPrefix: 'AM Platinum',
    sheetName(sheetName) {
      return prefixSheetName(this, sheetName);
    }
  };
}

function hmilSecondaryProfile() {
  return {
    id: 'hmil-secondary',
    brand: 'hyundai',
    displayName: 'HMIL Secondary',
    serviceName: 'hmil-cron-job',
    systemLabel: 'HMIL DMS',
    logPrefix: 'HMIL Secondary',
    defaultMode: 'hyundai-regular',
    cronSchedule: config.hmilCronSchedule,
    currentMonthOnly: config.hmilCurrentMonthOnly,
    loginUrl: config.hmilLoginUrl,
    homeUrl: config.hmilHomeUrl,
    userId: config.hmilSecondaryUserId || 'MIS5216',
    password: config.hmilSecondaryPassword,
    userIdEnvName: 'HMIL_SECONDARY_USER_ID',
    passwordEnvName: 'HMIL_SECONDARY_PASSWORD',
    forceLogin: config.hmilForceLogin,
    loginRetries: config.hmilLoginRetries,
    sessionCheckTimeoutMs: config.hmilSessionCheckTimeoutMs,
    sessionStatePath: config.hmilSecondarySessionStatePath,
    downloadDir: path.resolve(config.rootDir, './downloads/hmil-secondary'),
    reportChunksDir: path.resolve(config.rootDir, './downloads/report-chunks/hmil-secondary'),
    dealerCodes: config.hmilSecondaryDealerCodes,
    reportsToRun: config.hmilReportsToRun,
    headless: config.headless,
    repairOrderSheetName: config.hmilRepairOrderSheetName,
    repairOrderPageSize: config.hmilRepairOrderPageSize,
    repairOrderUseActiveDealerOnly: config.hmilRepairOrderUseActiveDealerOnly,
    repairOrderStartDate: config.hmilSecondaryRepairOrderStartDate,
    repairOrderEndDate: config.hmilSecondaryRepairOrderEndDate,
    repairOrderPostSearchDelayMs: config.hmilRepairOrderPostSearchDelayMs,
    healthFileName: 'hmil-secondary-health.json',
    otpPurpose: 'hmil',
    sheetName: sheetName => prefixSheetName({ sheetPrefix: '' }, sheetName)
  };
}

export function createGdmsAccountProfile(accountId = 'hmil') {
  if (accountId === 'am-platinum') {
    return amPlatinumProfile();
  }

  if (accountId === 'hmil') {
    return hmilProfile();
  }

  if (accountId === 'hmil-secondary') {
    return hmilSecondaryProfile();
  }

  throw new Error(`Unknown GDMS account profile: ${accountId}`);
}
