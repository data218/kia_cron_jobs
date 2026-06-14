import { config } from '../config.js';
import { createAmPlatinumAccount } from './am-platinum-accounts.js';

function warrantyAccount({
  id,
  displayName,
  userId,
  password,
  userIdEnvName,
  passwordEnvName,
  sessionStatePath
}) {
  return {
    id,
    brand: 'hyundai',
    displayName,
    serviceName: 'hmil-warranty-cron-job',
    systemLabel: 'HMIL DMS',
    logPrefix: `HMIL Warranty ${displayName}`,
    loginUrl: config.hmilLoginUrl,
    homeUrl: config.hmilHomeUrl,
    userId,
    password,
    userIdEnvName,
    passwordEnvName,
    forceLogin: config.hmilWarrantyForceLogin,
    sessionCheckTimeoutMs: config.hmilSessionCheckTimeoutMs,
    sessionStatePath,
    downloadDir: config.hmilWarrantyDownloadDir,
    reportChunksDir: config.hmilWarrantyReportChunksDir,
    headless: config.headless,
    otpPurpose: 'hmil'
  };
}

export function createHmilWarrantyAccounts() {
  return [
    warrantyAccount({
      id: 'hmil-warranty-primary',
      displayName: config.hmilUserId || 'primary',
      userId: config.hmilUserId,
      password: config.hmilPassword,
      userIdEnvName: 'HMIL_USER_ID',
      passwordEnvName: 'HMIL_PASSWORD',
      sessionStatePath: config.hmilWarrantyPrimarySessionStatePath
    }),
    warrantyAccount({
      id: 'hmil-warranty-secondary',
      displayName: config.hmilSecondaryUserId || 'secondary',
      userId: config.hmilSecondaryUserId,
      password: config.hmilSecondaryPassword,
      userIdEnvName: 'HMIL_SECONDARY_USER_ID',
      passwordEnvName: 'HMIL_SECONDARY_PASSWORD',
      sessionStatePath: config.hmilWarrantySecondarySessionStatePath
    })
  ];
}

export function createWarrantyScheduledAccounts() {
  const platinumAccount = createAmPlatinumAccount('current');

  return [
    ...createHmilWarrantyAccounts(),
    {
      ...platinumAccount,
      id: 'am-platinum-warranty',
      brand: 'hyundai',
      serviceName: 'hmil-warranty-cron-job',
      systemLabel: 'HMIL DMS',
      downloadDir: config.hmilWarrantyDownloadDir,
      reportChunksDir: config.hmilWarrantyReportChunksDir,
      headless: config.headless,
      otpPurpose: 'hmil',
      forceLogin: config.hmilWarrantyForceLogin
    }
  ];
}
