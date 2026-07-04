import { config } from '../config.js';
import { openPurchaseReport } from '../navigation/kia-menu.js';
import { downloadKiaMonthlySalesMisReport } from './kia-monthly-sales-mis-report.js';

export async function downloadKiaPurchaseReport(page, { dealerCode = 'active', mode = 'configured' } = {}) {
  return downloadKiaMonthlySalesMisReport(page, {
    dealerCode,
    mode,
    reportId: 'kia-purchase-report',
    name: 'Purchase Report',
    openReport: openPurchaseReport,
    startSelector: '#sQueryFromDate',
    endSelector: '#sQueryToDate',
    sheetName: config.kiaPurchaseReportSheetName,
    pageSize: config.kiaPurchaseReportPageSize,
    postSearchDelayMs: config.kiaPurchaseReportPostSearchDelayMs,
    betweenChunksDelayMs: config.kiaPurchaseReportBetweenChunksDelayMs,
    backfillStartDate: config.kiaPurchaseReportBackfillStartDate,
    clearTableBeforeSave: false
  });
}
