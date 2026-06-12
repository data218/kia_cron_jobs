import { config } from '../config.js';

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
    loginUrl: config.hmilLoginUrl,
    homeUrl: config.hmilHomeUrl,
    userId: config.hmilUserId,
    password: config.hmilPassword,
    userIdEnvName: 'HMIL_USER_ID',
    passwordEnvName: 'HMIL_PASSWORD',
    forceLogin: config.hmilForceLogin,
    sessionCheckTimeoutMs: config.hmilSessionCheckTimeoutMs,
    sessionStatePath: config.hmilSessionStatePath,
    downloadDir: config.hmilDownloadDir,
    reportChunksDir: config.hmilReportChunksDir,
    dealerCodes: config.hmilDealerCodes,
    reportsToRun: config.hmilReportsToRun,
    headless: config.headless,
    repairOrderSheetName: config.hmilRepairOrderSheetName,
    repairOrderPageSize: config.hmilRepairOrderPageSize,
    repairOrderStartDate: config.hmilRepairOrderStartDate,
    repairOrderEndDate: config.hmilRepairOrderEndDate,
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
    loginUrl: config.amPlatinumLoginUrl,
    homeUrl: config.amPlatinumHomeUrl,
    userId: config.amPlatinumUserId,
    password: config.amPlatinumPassword,
    userIdEnvName: 'AM_PLATINUM_USER_ID',
    passwordEnvName: 'AM_PLATINUM_PASSWORD',
    forceLogin: config.amPlatinumForceLogin,
    sessionCheckTimeoutMs: config.amPlatinumSessionCheckTimeoutMs,
    sessionStatePath: config.amPlatinumSessionStatePath,
    downloadDir: config.amPlatinumDownloadDir,
    reportChunksDir: config.amPlatinumReportChunksDir,
    dealerCodes: config.amPlatinumDealerCodes,
    reportsToRun: config.amPlatinumReportsToRun,
    headless: config.headless,
    repairOrderSheetName: config.amPlatinumRepairOrderSheetName,
    repairOrderPageSize: config.amPlatinumRepairOrderPageSize,
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

export function createGdmsAccountProfile(accountId = 'hmil') {
  if (accountId === 'am-platinum') {
    return amPlatinumProfile();
  }

  if (accountId === 'hmil') {
    return hmilProfile();
  }

  throw new Error(`Unknown GDMS account profile: ${accountId}`);
}
