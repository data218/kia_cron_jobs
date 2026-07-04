process.env.HMIL_HISTORICAL_START_DATE = '2025-01-01';
process.env.HMIL_HISTORICAL_OTP_PROVIDER ??= 'webhook';

const { toIsoDate } = await import('../src/utils/date-range.js');
const { createGdmsAccountProfile } = await import('../src/accounts/gdms-account-profile.js');
const { analyzeHmilPerDealerCoverage } = await import('./analyze-hmil-per-dealer-coverage.js');
const { runGdmsReportFirstHistoricalBackfill } = await import('./hmil-report-first-historical-runner.js');

process.env.HMIL_HISTORICAL_END_DATE = toIsoDate(new Date());

const coverage = await analyzeHmilPerDealerCoverage({ writeReport: true });
const missingReportIds = [...new Set(coverage.queue.map(item => item.reportId))];
const missingDealerCodes = [...new Set(coverage.queue.map(item => item.dealerCode))];
const primaryAccount = createGdmsAccountProfile('hmil');
const secondaryAccount = createGdmsAccountProfile('hmil-secondary');
const primaryDealers = missingDealerCodes.filter(dealerCode => primaryAccount.dealerCodes.includes(dealerCode));
const secondaryDealers = missingDealerCodes.filter(dealerCode => secondaryAccount.dealerCodes.includes(dealerCode));

if (!missingReportIds.length || !missingDealerCodes.length) {
  console.log('No HMIL catch-up is required. All non-excluded reports already cover Jan 2025 to current month.');
  process.exit(0);
}

process.env.HMIL_HISTORICAL_REPORTS = missingReportIds.join(',');

console.log('Starting HMIL catch-up for missing reports only...');
console.log(`Primary dealers: ${primaryDealers.join(', ') || '(none)'}`);
console.log(`Secondary dealers: ${secondaryDealers.join(', ') || '(none)'}`);
console.log(`Start Date: ${process.env.HMIL_HISTORICAL_START_DATE}`);
console.log(`End Date: ${process.env.HMIL_HISTORICAL_END_DATE}`);
console.log(`Reports: ${process.env.HMIL_HISTORICAL_REPORTS}`);

async function runCatchupForAccount({
  accountId,
  dealers,
  stateFileName,
  logFilePrefix,
  serviceName
}) {
  if (!dealers.length) {
    return;
  }

  process.env.HMIL_HISTORICAL_DEALERS = dealers.join(',');
  console.log(`Running ${accountId} catch-up for dealers: ${process.env.HMIL_HISTORICAL_DEALERS}`);

  await runGdmsReportFirstHistoricalBackfill({
    accountId,
    envPrefix: 'HMIL',
    stateFileName,
    logFilePrefix,
    serviceName,
    defaultStartDate: '2025-01-01',
    defaultHeadless: true,
    historicalReportIds: missingReportIds
  });
}

await runCatchupForAccount({
  accountId: 'hmil',
  dealers: primaryDealers,
  stateFileName: 'hmil-missing-reports-catchup-primary-state.json',
  logFilePrefix: 'hmil-missing-reports-catchup-primary',
  serviceName: 'hmil-missing-reports-catchup-primary'
});

await runCatchupForAccount({
  accountId: 'hmil-secondary',
  dealers: secondaryDealers,
  stateFileName: 'hmil-missing-reports-catchup-secondary-state.json',
  logFilePrefix: 'hmil-missing-reports-catchup-secondary',
  serviceName: 'hmil-missing-reports-catchup-secondary'
});

console.log('HMIL missing-report catch-up finished.');
