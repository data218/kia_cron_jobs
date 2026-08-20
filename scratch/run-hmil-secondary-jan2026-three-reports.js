import { runGdmsReportFirstHistoricalBackfill } from '../scripts/hmil-report-first-historical-runner.js';

await runGdmsReportFirstHistoricalBackfill({
  accountId: 'hmil-secondary',
  stateFileName: 'hmil-secondary-jan2026-three-reports-state.json',
  logFilePrefix: 'hmil-secondary-jan2026-three-reports',
  serviceName: 'hmil-secondary-jan2026-three-reports'
});
