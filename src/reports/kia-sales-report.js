import { config } from '../config.js';
import { openSalesReport } from '../navigation/kia-menu.js';
import { logger } from '../utils/logger.js';
import { downloadKiaMonthlySalesMisReport } from './kia-monthly-sales-mis-report.js';

async function selectDeliveryDateRadio(context) {
  const radio = context.locator([
    '#deliverydate',
    '#deliveryDate',
    'input[type="radio"][value="deliveryDate"]',
    'input[type="radio"][name="radio"][value="deliveryDate"]',
    'label:has-text("Delivery date") input[type="radio"]',
    'label:has-text("Delivery Date") input[type="radio"]'
  ].join(',')).first();

  await radio.waitFor({ state: 'visible', timeout: 30000 });
  await radio.check({ force: true }).catch(async () => {
    await radio.click({ force: true });
  });
  logger.info('Sales Report delivery date radio selected');
}

export async function downloadKiaSalesReport(page, { dealerCode = 'active', mode = 'configured' } = {}) {
  return downloadKiaMonthlySalesMisReport(page, {
    dealerCode,
    mode,
    reportId: 'kia-sales-report',
    name: 'Sales Report',
    openReport: openSalesReport,
    startSelector: '#sDateFromDate',
    endSelector: '#sDateToDate',
    sheetName: config.kiaSalesReportSheetName,
    pageSize: config.kiaSalesReportPageSize,
    postSearchDelayMs: config.kiaSalesReportPostSearchDelayMs,
    betweenChunksDelayMs: config.kiaSalesReportBetweenChunksDelayMs,
    backfillStartDate: config.kiaSalesReportBackfillStartDate,
    prepareContext: selectDeliveryDateRadio,
    prepareChunk: selectDeliveryDateRadio,
    clearTableBeforeSave: false
  });
}
