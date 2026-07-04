process.env.HMIL_RO_BILLING_2008_2020_HISTORICAL_START_DATE ??= '2008-01-01';
process.env.HMIL_RO_BILLING_2008_2020_HISTORICAL_END_DATE ??= '2020-12-31';
process.env.HMIL_RO_BILLING_2008_2020_HISTORICAL_REPORTS ??= 'hyundai-ro-billing-report';
process.env.HMIL_RO_BILLING_2008_2020_HISTORICAL_OTP_PROVIDER ??= 'webhook';
process.env.HMIL_RO_BILLING_2008_2020_HISTORICAL_RESUME_FROM_STATE ??= 'true';
process.env.HMIL_RO_BILLING_2008_2020_HISTORICAL_STOP_ON_FAILURE ??= 'false';
process.env.HMIL_RO_BILLING_2008_2020_HISTORICAL_SKIP_EXISTING ??= 'false';
process.env.HMIL_RO_BILLING_2008_2020_HISTORICAL_HEADLESS ??= process.env.HEADLESS ?? 'false';

import { runGdmsReportFirstHistoricalBackfill } from './hmil-report-first-historical-runner.js';

await runGdmsReportFirstHistoricalBackfill({
  accountId: 'hmil',
  envPrefix: 'HMIL_RO_BILLING_2008_2020',
  stateFileName: 'hmil-ro-billing-2008-2020-state.json',
  logFilePrefix: 'hmil-ro-billing-2008-2020',
  serviceName: 'hmil-ro-billing-2008-2020',
  defaultStartDate: '2008-01-01',
  historicalReportIds: ['hyundai-ro-billing-report'],
  customizeReports: reports => reports.map(report => (
    report.id === 'hyundai-ro-billing-report'
      ? {
          ...report,
          name: 'Hyundai RO Billing Report 2008-2020',
          sheetName: 'hyundai_ro_billing_report_2008_2020_archive'
        }
      : report
  ))
});
