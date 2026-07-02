import { config } from '../config.js';
import { openAccessoriesCounterSalesReport } from '../navigation/kia-menu.js';
import { downloadKiaMonthlySalesMisReport } from './kia-monthly-sales-mis-report.js';

export async function downloadKiaAccessoriesCounterSalesReport(page, { dealerCode = 'active', mode = 'configured' } = {}) {
  return downloadKiaMonthlySalesMisReport(page, {
    dealerCode,
    mode,
    reportId: 'kia-accessories-counter-sales-report',
    name: 'Accessories Counter Sales Report',
    openReport: openAccessoriesCounterSalesReport,
    startSelector: '#sv_fromDate',
    endSelector: '#sv_toDate',
    sheetName: config.kiaAccessoriesCounterSalesSheetName,
    pageSize: config.kiaAccessoriesCounterSalesPageSize,
    postSearchDelayMs: config.kiaAccessoriesCounterSalesPostSearchDelayMs,
    betweenChunksDelayMs: config.kiaAccessoriesCounterSalesBetweenChunksDelayMs,
    backfillStartDate: config.kiaAccessoriesCounterSalesBackfillStartDate,
    // This report now runs dealer-by-dealer, so we must append across dealers
    // instead of clearing the table on every dealer switch.
    clearTableBeforeSave: false
  });
}
