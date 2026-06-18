const startArg = process.argv.find(arg => arg.startsWith('--start='))?.slice('--start='.length)
  ?? process.env.HMIL_WARRANTY_RUN_START_DATE
  ?? '2026-05-01';

process.env.HMIL_WARRANTY_HISTORICAL_START_DATE = startArg;
process.env.HMIL_WARRANTY_FORCE_LOGIN = process.env.HMIL_WARRANTY_FORCE_LOGIN ?? 'true';
process.env.OTP_PROVIDER = process.env.OTP_PROVIDER ?? 'webhook';

const { createHmilWarrantyAccounts } = await import('../src/accounts/hmil-warranty-accounts.js');
const { runHmilWarrantyJob } = await import('../src/cron/hmil-warranty-scheduler.js');
const { config } = await import('../src/config.js');

const accounts = createHmilWarrantyAccounts();
const secondary = accounts.find(account => account.id === 'hmil-warranty-secondary');

if (!secondary?.userId || !secondary?.password) {
  throw new Error('MIS5216 warranty account is not configured (HMIL_SECONDARY_USER_ID / HMIL_SECONDARY_PASSWORD)');
}

const dealers = config.hmilWarrantySecondaryDealerCodes;
const endIso = new Date().toISOString().slice(0, 10);

console.log('');
console.log('HMIL Warranty one-off run — MIS5216');
console.log(`Login: ${secondary.userId}`);
console.log(`Date range: ${startArg} to ${endIso} (today)`);
console.log('Reports: Claim List + Claim YTP');
console.log(`Dealers: ${dealers.join(', ')}`);
console.log('Resume: disabled (force re-fetch and save)');
console.log('');

const results = await runHmilWarrantyJob('scheduled', {
  accounts: [secondary],
  skipTableClear: true,
  resume: false
});

const saved = results.filter(result =>
  result.status === 'success' &&
  (result.dbResult?.addedRowCount > 0 || result.dbResult?.insertedRowCount > 0 || result.dbResult?.rowCount > 0)
);
const noRows = results.filter(result => result.dbResult?.action === 'no_rows');
const failed = results.filter(result => result.status === 'failed');

console.log('');
console.log('Run summary');
console.log(`  Total tasks: ${results.length}`);
console.log(`  With saved rows: ${saved.length}`);
console.log(`  No rows in DMS: ${noRows.length}`);
console.log(`  Failed: ${failed.length}`);

if (failed.length) {
  for (const item of failed) {
    console.log(`  FAIL ${item.dealerCode} ${item.reportId}: ${item.error?.message ?? 'unknown'}`);
  }
}

for (const item of results) {
  const rows = item.dbResult?.rowCount ?? item.dbResult?.addedRowCount ?? 0;
  const action = item.dbResult?.action ?? item.status;
  console.log(`  ${item.dealerCode} ${item.reportId}: ${action} (${rows} rows)`);
}

if (failed.length) {
  process.exitCode = 1;
}
