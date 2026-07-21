import { config } from '../config.js';
import { openReceiptReport } from '../navigation/kia-menu.js';
import { downloadKiaMonthlySalesMisReport } from './kia-monthly-sales-mis-report.js';

export async function downloadKiaReceiptReport(page, { dealerCode = 'active', mode = 'configured' } = {}) {
  return downloadKiaMonthlySalesMisReport(page, {
    dealerCode,
    mode,
    reportId: 'kia-receipt-report',
    name: 'Receipt Report',
    openReport: openReceiptReport,
    startSelector: '#sQueryFromDate',
    endSelector: '#sQueryToDate',
    sheetName: config.kiaReceiptReportSheetName,
    pageSize: config.kiaReceiptReportPageSize,
    postSearchDelayMs: config.kiaReceiptReportPostSearchDelayMs,
    betweenChunksDelayMs: config.kiaReceiptReportBetweenChunksDelayMs,
    backfillStartDate: config.kiaReceiptReportBackfillStartDate,
    clearTableBeforeSave: false
  });
}
