import { runGdmsReportFirstHistoricalBackfill } from './hmil-report-first-historical-runner.js';

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function slugifyReportId(reportId) {
  return String(reportId || 'all').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

const reportSlug = slugifyReportId(env('AM_PLATINUM_HISTORICAL_REPORTS', 'all').split(',')[0]);

await runGdmsReportFirstHistoricalBackfill({
  accountId: 'am-platinum',
  envPrefix: 'AM_PLATINUM',
  stateFileName: env('AM_PLATINUM_HISTORICAL_STATE_FILE', `am-platinum-historical-${reportSlug}-state.json`),
  logFilePrefix: env('AM_PLATINUM_HISTORICAL_LOG_PREFIX', `am-platinum-historical-${reportSlug}`),
  serviceName: env('LOG_SERVICE_NAME', `am-platinum-hist-${reportSlug}`),
  defaultHeadless: false,
  optimizedFullRangeNoSearch: false
});
