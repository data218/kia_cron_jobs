import { config } from '../config.js';
import { openRoBillingReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { getRollingOneMonthPlusOneDayRange } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { exportPagedGridToSupabase } from './paged-export.js';
import { clickSearch, fillDate } from './report-actions.js';

async function resolveRoBillingContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sBillDateFromDate', {
    timeout: 90000,
    label: 'RO Billing Bill Date From'
  });

  await context.locator('#sBillDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('R/O Billing Report page loaded');
  return context;
}

export async function downloadRoBillingReport(page) {
  logger.info('RO Billing report started');
  await openRoBillingReport(page);
  const reportContext = await resolveRoBillingContext(page);

  const range = getRollingOneMonthPlusOneDayRange();
  logger.info('Applying RO Billing date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(reportContext, '#sBillDateFromDate', range.startPortal);
  await fillDate(reportContext, '#sBillDateToDate', range.endPortal);

  logger.info('Searching RO Billing report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });
  logger.info('Waiting briefly after initial search before changing page size', {
    delayMs: config.roBillingPostSearchDelayMs
  });
  await sleep(config.roBillingPostSearchDelayMs);

  await selectKendoPagerSize(reportContext, config.roBillingPageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Exporting RO Billing report pages');
  const dbResult = await exportPagedGridToSupabase(reportContext, {
    reportId: 'ro-billing',
    sheetName: config.roBillingSheetName,
    filenameBase: `ro_billing_report_${range.endIso}`,
    pageSize: config.roBillingPageSize
  });
  logger.info('RO Billing report finished', {
    sheetName: config.roBillingSheetName,
    dbAction: dbResult.action,
    rowCount: dbResult.rowCount,
    headerCount: dbResult.headerCount,
    pageCount: dbResult.pageCount
  });

  return {
    name: 'RO Billing Report',
    sheetName: config.roBillingSheetName,
    dbResult,
    dateRange: range
  };
}
