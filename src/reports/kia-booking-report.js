import { config } from '../config.js';
import { openBookingReport } from '../navigation/kia-menu.js';
import { downloadKiaMonthlySalesMisReport } from './kia-monthly-sales-mis-report.js';

export async function downloadKiaBookingReport(page, { dealerCode = 'active', mode = 'configured' } = {}) {
  return downloadKiaMonthlySalesMisReport(page, {
    dealerCode,
    mode,
    reportId: 'kia-booking-report',
    name: 'Booking Report',
    openReport: openBookingReport,
    startSelector: '#sFromDate',
    endSelector: '#sToDate',
    sheetName: config.kiaBookingReportSheetName,
    pageSize: config.kiaBookingReportPageSize,
    postSearchDelayMs: config.kiaBookingReportPostSearchDelayMs,
    betweenChunksDelayMs: config.kiaBookingReportBetweenChunksDelayMs,
    backfillStartDate: config.kiaBookingReportBackfillStartDate,
    clearTableBeforeSave: false
  });
}
