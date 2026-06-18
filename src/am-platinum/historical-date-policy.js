export const AM_PLATINUM_FULL_HISTORICAL_START = '2021-01-01';
export const AM_PLATINUM_RECENT_HISTORICAL_START = '2024-01-01';
export const AM_PLATINUM_REMAINING_REPORTS_START = '2025-01-01';

export const AM_PLATINUM_FULL_HISTORICAL_REPORT_IDS = new Set([
  'hyundai-repair-order-list',
  'hyundai-ro-billing-report',
  'hyundai-operation-wise-analysis-report'
]);

export function historicalStartDateForReport(reportId) {
  return AM_PLATINUM_FULL_HISTORICAL_REPORT_IDS.has(String(reportId || '').trim())
    ? AM_PLATINUM_FULL_HISTORICAL_START
    : AM_PLATINUM_RECENT_HISTORICAL_START;
}

export function isFullHistoricalReport(reportId) {
  return AM_PLATINUM_FULL_HISTORICAL_REPORT_IDS.has(String(reportId || '').trim());
}
