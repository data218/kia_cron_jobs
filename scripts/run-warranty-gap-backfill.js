import fs from 'node:fs/promises';
import path from 'node:path';
import { createWarrantyScheduledAccounts } from '../src/accounts/hmil-warranty-accounts.js';
import { runHmilWarrantyJob } from '../src/cron/hmil-warranty-scheduler.js';
import { config } from '../src/config.js';
import { hmilWarrantyReportDefinitions } from '../src/reports/hmil-warranty-reports.js';
import {
  analyzeWarrantyCoverage,
  buildGapBackfillPlan
} from './analyze-warranty-coverage.js';

process.env.OTP_PROVIDER = process.env.OTP_PROVIDER ?? 'webhook';

const report = await analyzeWarrantyCoverage();
const plan = buildGapBackfillPlan(report);

console.log('');
console.log('Warranty gap-only backfill');
console.log(`Range: ${report.rangeStart} to ${report.rangeEnd}`);
console.log('');

if (!plan.reports.length) {
  console.log('No gaps found — nothing to run.');
  process.exit(0);
}

const accounts = createWarrantyScheduledAccounts()
  .filter(account => plan.accountIds.includes(account.id));

console.log('Accounts:', accounts.map(account => account.userId).join(', '));
console.log('Reports:', plan.reports.join(', '));
console.log('Dealers by account:');
for (const [login, dealers] of Object.entries(plan.dealerCodesByAccount)) {
  console.log(`  ${login}: ${dealers.join(', ')}`);
}

if (plan.claimListGaps.length) {
  console.log('');
  console.log('Claim List will fetch only missing months (resume mode).');
  for (const gap of plan.claimListGaps) {
    console.log(`  ${gap.login}/${gap.dealerCode}: ${gap.missingMonths.join(', ')}`);
  }
}

if (plan.claimYtpGaps.length) {
  console.log('');
  console.log('Claim YTP will run for dealers with no saved rows.');
}

const outPath = path.join(config.logsDir, 'warranty-gap-backfill-plan.json');
await fs.mkdir(config.logsDir, { recursive: true });
await fs.writeFile(outPath, JSON.stringify({
  startedAt: new Date().toISOString(),
  plan
}, null, 2));

const reports = hmilWarrantyReportDefinitions.filter(def => plan.reports.includes(def.id));

const results = await runHmilWarrantyJob('scheduled', {
  accounts,
  reports,
  dealerCodesByAccount: plan.dealerCodesByAccount,
  skipTableClear: true,
  resume: true
});

const saved = results.filter(result =>
  result.status === 'success' &&
  (result.dbResult?.rowCount > 0 || result.dbResult?.insertedRowCount > 0 || result.dbResult?.addedRowCount > 0)
);
const skipped = results.filter(result => result.dbResult?.action === 'skipped_resume' || result.dbResult?.action === 'no_rows');
const failed = results.filter(result => result.status === 'failed');

console.log('');
console.log('Gap backfill summary');
console.log(`  Tasks: ${results.length}`);
console.log(`  Saved rows: ${saved.length}`);
console.log(`  No rows / skipped: ${skipped.length}`);
console.log(`  Failed: ${failed.length}`);

for (const item of results) {
  const rows = item.dbResult?.rowCount ?? 0;
  const action = item.dbResult?.action ?? item.status;
  console.log(`  ${item.sourceLoginId} ${item.dealerCode} ${item.reportId}: ${action} (${rows} rows)`);
}

if (failed.length) {
  process.exitCode = 1;
}
