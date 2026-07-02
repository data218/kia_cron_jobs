import { config } from '../config.js';
import { openEnquiryReport } from '../navigation/kia-menu.js';
import { downloadKiaMonthlySalesMisReport } from './kia-monthly-sales-mis-report.js';

export async function downloadKiaEnquiryReport(page, { dealerCode = 'active', mode = 'configured' } = {}) {
  return downloadKiaMonthlySalesMisReport(page, {
    dealerCode,
    mode,
    reportId: 'kia-enquiry-report',
    name: 'Enquiry Report',
    openReport: openEnquiryReport,
    startSelector: '#sDateFromDate',
    endSelector: '#sDateToDate',
    sheetName: config.kiaEnquiryReportSheetName,
    pageSize: config.kiaEnquiryReportPageSize,
    postSearchDelayMs: config.kiaEnquiryReportPostSearchDelayMs,
    betweenChunksDelayMs: config.kiaEnquiryReportBetweenChunksDelayMs,
    backfillStartDate: config.kiaEnquiryReportBackfillStartDate,
    clearTableBeforeSave: false
  });
}
