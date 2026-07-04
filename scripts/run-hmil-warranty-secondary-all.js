import fs from 'node:fs/promises';
import { createHmilWarrantyAccounts } from '../src/accounts/hmil-warranty-accounts.js';
import { config } from '../src/config.js';
import {
  getWarrantyDealerCodesForAccount,
  runHmilWarrantyJob
} from '../src/cron/hmil-warranty-scheduler.js';
import { withPostgresClient } from '../src/supabase/postgres.js';

const TABLES = [
  { table: 'hyundai_warranty_claim_list', label: 'Claim List' },
  { table: 'hyundai_warranty_claim_ytp', label: 'Claim YTP' }
];

function resolveSecondaryAccount() {
  const account = createHmilWarrantyAccounts().find(entry => entry.id === 'hmil-warranty-secondary');
  if (!account) {
    throw new Error('Could not resolve hmil-warranty-secondary (MIS5216) account');
  }
  return account;
}

async function clearSecondarySession(account) {
  await fs.unlink(account.sessionStatePath).catch(() => {});
  await fs.unlink(`${account.sessionStatePath}.meta.json`).catch(() => {});
}

async function printPostRunSummary(account, dealers) {
  console.log('');
  console.log('Post-run DB check (MIS5216 dealers only):');
  console.log('-'.repeat(72));

  await withPostgresClient(async client => {
    for (const dealerCode of dealers) {
      const parts = [];
      for (const spec of TABLES) {
        const result = await client.query(
          `SELECT COUNT(*)::int AS c
           FROM public.${spec.table}
           WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))
             AND lower(trim(source_login_id::text)) = lower(trim($2::text))`,
          [dealerCode, account.userId]
        );
        parts.push(`${spec.label}=${result.rows[0]?.c ?? 0}`);
      }
      console.log(`  ${dealerCode}: ${parts.join(' | ')}`);
    }
  });

  console.log('');
  console.log(`Full status: node scripts/analyze-warranty-coverage-by-login.js`);
  console.log(`Per dealer:  node scripts/check-hmil-warranty-dealer-coverage.js <dealer>`);
  console.log('');
}

async function main() {
  const account = resolveSecondaryAccount();
  const dealers = getWarrantyDealerCodesForAccount(account);
  const resume = process.env.HMIL_WARRANTY_RESUME !== 'false';

  process.env.HEADLESS = 'false';
  process.env.OTP_PROVIDER = process.env.OTP_PROVIDER || 'manual';
  process.env.HMIL_WARRANTY_HISTORICAL_OTP_PROVIDER = 'manual';
  process.env.GDMS_OTP_LOCK_ENABLED = 'false';
  process.env.HMIL_WARRANTY_FORCE_LOGIN = process.env.HMIL_WARRANTY_FORCE_LOGIN ?? 'true';
  process.env.HMIL_WARRANTY_FORCE_YTP = 'true';
  process.env.LOG_SERVICE_NAME = 'hmil-warranty-secondary-all';

  console.log('');
  console.log('='.repeat(72));
  console.log('  HMIL Warranty Secondary Backfill (MIS5216 only)');
  console.log('='.repeat(72));
  console.log(`  Login: ${account.userId}`);
  console.log(`  Dealers (${dealers.length}): ${dealers.join(', ')}`);
  console.log(`  Reports: Warranty Claim List + Claim YTP`);
  console.log(`  Range: ${config.hmilWarrantyHistoricalStartDate} → today`);
  console.log(`  Resume Claim List months already loaded: ${resume ? 'yes' : 'no'}`);
  console.log(`  Force Claim YTP re-export: yes`);
  console.log('='.repeat(72));
  console.log('');

  if (process.env.HMIL_WARRANTY_SECONDARY_CLEAR_SESSION !== 'false') {
    await clearSecondarySession(account);
    console.log('Cleared MIS5216 session cache.');
    console.log('');
  }

  const results = await runHmilWarrantyJob('historical', {
    accounts: [account],
    dealerCodesByAccount: {
      [account.userId]: dealers
    },
    skipTableClear: true,
    resume
  });

  const failed = results.filter(result => result.status === 'failed');
  await printPostRunSummary(account, dealers);

  if (failed.length) {
    console.error(`Finished with ${failed.length} failed dealer/report item(s).`);
    for (const item of failed) {
      console.error(`  - ${item.reportId ?? item.report} [${item.dealerCode}]: ${item.error?.message ?? item.phase ?? 'failed'}`);
    }
    process.exitCode = 1;
  } else {
    console.log('Secondary warranty backfill completed without failures.');
  }
}

main().catch(error => {
  console.error('Secondary warranty backfill failed:', error);
  process.exitCode = 1;
});
