// Setup environment overrides BEFORE importing config or runner modules
process.env.HMIL_USER_ID = 'sahiltech';
process.env.HMIL_PASSWORD = 'Amgroup@321';
process.env.HMIL_HISTORICAL_START_DATE = '2025-01-01';
process.env.HMIL_HISTORICAL_OTP_PROVIDER = 'webhook';

// Force the list of dealers to be the old dealer codes corresponding to the shared list
process.env.HMIL_HISTORICAL_DEALERS = 'N5203,N5701,N5804,N6815,N6819,N6828';

// Set the remaining 8 reports (excluding ro billing, repair order, operation wise, and adv wise lubricants & VAS)
const remainingReports = [
  'hyundai-call-center-complaints',
  'hyundai-demo-car-list',
  'hyundai-service-appointment',
  'hyundai-trust-package-bodyshop-sot',
  'hyundai-trust-package-sot-super',
  'hyundai-trust-package-package-list',
  'hyundai-psf-yearly',
  'hyundai-ew-report'
];

process.env.HMIL_HISTORICAL_REPORTS = remainingReports.join(',');

// Now perform dynamic imports
const { toIsoDate } = await import('../src/utils/date-range.js');
process.env.HMIL_HISTORICAL_END_DATE = toIsoDate(new Date());

const { runGdmsReportFirstHistoricalBackfill } = await import('./hmil-report-first-historical-runner.js');

console.log('Starting historical backfill for HMIL Primary (sahiltech)...');
console.log(`Dealers: ${process.env.HMIL_HISTORICAL_DEALERS}`);
console.log(`Start Date: ${process.env.HMIL_HISTORICAL_START_DATE}`);
console.log(`End Date: ${process.env.HMIL_HISTORICAL_END_DATE}`);
console.log(`Reports: ${remainingReports.join(', ')}`);

await runGdmsReportFirstHistoricalBackfill({
  accountId: 'hmil', // Using the old ID profile
  envPrefix: 'HMIL',
  stateFileName: 'hmil-primary-remaining-backfill-state.json',
  logFilePrefix: 'hmil-primary-remaining-backfill',
  serviceName: 'hmil-primary-remaining-backfill',
  defaultStartDate: '2025-01-01',
  defaultHeadless: true,
  historicalReportIds: remainingReports
});

console.log('Backfill process finished.');
