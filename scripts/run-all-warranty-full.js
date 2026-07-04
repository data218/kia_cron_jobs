import { config } from '../src/config.js';
import {
  createAmPlatinumAccount,
  applyHistoricalRunOptions,
  listAmPlatinumSessionCachePaths
} from '../src/accounts/am-platinum-accounts.js';
import { createHmilWarrantyAccounts } from '../src/accounts/hmil-warranty-accounts.js';
import {
  executeHmilWarrantySequence,
  getWarrantyDealerCodesForAccount
} from '../src/cron/hmil-warranty-scheduler.js';
import {
  clearHmilWarrantyTables,
  hmilWarrantyReportDefinitions
} from '../src/reports/hmil-warranty-reports.js';
import fs from 'node:fs/promises';

const RAJOURI_HISTORICAL_FETCH = 'N6824';

function summarizeResults(results) {
  const success = results.filter(result => result.status === 'success').length;
  const failed = results.filter(result => result.status === 'failed').length;
  return { success, failed, total: results.length };
}

function createPlatinumWarrantyAccount(accountKey) {
  const account = applyHistoricalRunOptions(createAmPlatinumAccount(accountKey));
  return {
    ...account,
    headless: false,
    otpProvider: 'manual',
    downloadDir: config.hmilWarrantyDownloadDir,
    reportChunksDir: config.hmilWarrantyReportChunksDir,
    forceLogin: accountKey === 'current'
      ? (process.env.AM_PLATINUM_FORCE_LOGIN !== 'false')
      : (process.env.AM_PLATINUM_HISTORICAL_FORCE_LOGIN === 'true'
        || process.env.AM_PLATINUM_FORCE_LOGIN === 'true')
  };
}

function platinumDealersForAccount(accountKey, dealers) {
  if (accountKey === 'historical') {
    return dealers.map(code => (code === 'N6250' ? RAJOURI_HISTORICAL_FETCH : code));
  }

  return dealers;
}

async function clearSessionFile(filePath) {
  await fs.unlink(filePath).catch(() => {});
  await fs.unlink(`${filePath}.meta.json`).catch(() => {});
}

async function clearWarrantySessions() {
  const paths = new Set([
    config.hmilWarrantyPrimarySessionStatePath,
    config.hmilWarrantySecondarySessionStatePath,
    config.hmilSessionStatePath,
    ...listAmPlatinumSessionCachePaths()
  ]);

  for (const filePath of paths) {
    await clearSessionFile(filePath);
  }
}

async function main() {
  const resume = process.env.HMIL_WARRANTY_RESUME === 'true' || config.hmilWarrantyResume;

  process.env.HEADLESS = 'false';
  process.env.OTP_PROVIDER = 'manual';
  process.env.HMIL_WARRANTY_HISTORICAL_OTP_PROVIDER = 'manual';
  process.env.GDMS_OTP_LOCK_ENABLED = 'false';

  const hmilAccounts = createHmilWarrantyAccounts().map(account => ({
    ...account,
    headless: false,
    otpProvider: 'manual',
    forceLogin: config.hmilWarrantyForceLogin
  }));

  const platinumAccounts = [
    createPlatinumWarrantyAccount('current'),
    createPlatinumWarrantyAccount('historical')
  ];

  const platinumDealers = config.amPlatinumDealerCodes.length
    ? [...config.amPlatinumDealerCodes]
    : ['N5211', 'N6250', 'N6828'];

  const hmilDealerCodesByAccount = Object.fromEntries(
    hmilAccounts.map(account => [account.userId, getWarrantyDealerCodesForAccount(account)])
  );

  const platinumDealerCodesByAccount = Object.fromEntries(
    platinumAccounts.map(account => {
      const accountKey = account.id === 'am-platinum-historical' ? 'historical' : 'current';
      return [account.userId, platinumDealersForAccount(accountKey, platinumDealers)];
    })
  );

  console.log('');
  console.log('═'.repeat(72));
  console.log('  Full Warranty Run — Hyundai + AM Platinum');
  console.log('═'.repeat(72));
  console.log(`  Date range: ${config.hmilWarrantyHistoricalStartDate} → today`);
  console.log('  Reports per dealer: Warranty Claim List + Claim YTP');
  console.log('  Claim List: month-wise with Search');
  console.log('  Claim YTP: full range, no Search, page size 300, fast skip if empty');
  console.log(`  Resume mode: ${resume ? 'ON (keep existing DB rows, skip completed work)' : 'OFF (clear tables first)'}`);
  console.log('  OTP: manual — enter OTP when each login starts');
  console.log('');
  console.log('  Phase 1 — Hyundai HMIL');
  for (const account of hmilAccounts) {
    console.log(`    ${account.userId}: ${hmilDealerCodesByAccount[account.userId].join(', ')}`);
  }
  console.log('');
  console.log('  Phase 2 — AM Platinum');
  for (const account of platinumAccounts) {
    console.log(`    ${account.userId}: ${platinumDealerCodesByAccount[account.userId].join(', ')}`);
  }
  console.log('═'.repeat(72));
  console.log('');

  if (!resume) {
    await clearWarrantySessions();
    await clearHmilWarrantyTables();
  } else {
    console.log('Resume mode: keeping existing warranty tables and session cache.\n');
  }

  const allResults = [];

  console.log('▶ Phase 1/2: Hyundai HMIL warranty (sahiltech → MIS5216)\n');
  const hmilResults = await executeHmilWarrantySequence({
    mode: 'historical',
    accounts: hmilAccounts,
    reports: hmilWarrantyReportDefinitions,
    dealerCodesByAccount: hmilDealerCodesByAccount,
    resume
  });
  allResults.push(...hmilResults);

  const hmilSummary = summarizeResults(hmilResults);
  console.log(`\nPhase 1 done: ${hmilSummary.success}/${hmilSummary.total} succeeded, ${hmilSummary.failed} failed\n`);

  console.log('▶ Phase 2/2: AM Platinum warranty (MIS1988 → MIS12345)\n');
  const platinumResults = await executeHmilWarrantySequence({
    mode: 'historical',
    accounts: platinumAccounts,
    reports: hmilWarrantyReportDefinitions,
    dealerCodesByAccount: platinumDealerCodesByAccount,
    resume
  });
  allResults.push(...platinumResults);

  const platinumSummary = summarizeResults(platinumResults);
  const overall = summarizeResults(allResults);

  console.log('');
  console.log('═'.repeat(72));
  console.log('  FULL WARRANTY RUN COMPLETE');
  console.log('═'.repeat(72));
  console.log(`  Hyundai:  ${hmilSummary.success}/${hmilSummary.total} ok, ${hmilSummary.failed} failed`);
  console.log(`  Platinum: ${platinumSummary.success}/${platinumSummary.total} ok, ${platinumSummary.failed} failed`);
  console.log(`  Overall:  ${overall.success}/${overall.total} ok, ${overall.failed} failed`);
  console.log('═'.repeat(72));
  console.log('');

  if (overall.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
