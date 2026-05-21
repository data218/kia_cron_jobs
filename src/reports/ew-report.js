import { config } from '../config.js';
import { openEwReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { getCurrentMonthToDateRange } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { exportPagedGridToSupabase } from './paged-export.js';
import {
  clickSearch,
  fillDate
} from './report-actions.js';

async function resolveEwReportContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sRegDateFromDate', {
    timeout: 90000,
    label: 'EW Report Registration Date From'
  });

  await context.locator('#sRegDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#sDlrmRgnOfceNo').first().waitFor({ state: 'attached', timeout: 30000 }).catch(() => {});
  logger.info('Extended Warranty Report page loaded');
  return context;
}

async function fillEwDateRange(page, range) {
  logger.info('Applying EW Report date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(page, '#sRegDateToDate', range.endPortal);
  await sleep(500);
  await fillDate(page, '#sRegDateFromDate', range.startPortal);
}

export async function downloadEwReport(page) {
  logger.info('EW Report started');
  await openEwReport(page);
  const reportContext = await resolveEwReportContext(page);

  const range = getCurrentMonthToDateRange();
  await fillEwDateRange(reportContext, range);

  logger.info('Searching EW Report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Waiting briefly after EW Report search before changing page size', {
    delayMs: config.ewReportPostSearchDelayMs
  });
  await sleep(config.ewReportPostSearchDelayMs);

  await selectKendoPagerSize(reportContext, config.ewReportPageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Exporting EW Report pages');
  const dbResult = await exportPagedGridToSupabase(reportContext, {
    reportId: 'ew-report',
    sheetName: config.ewReportSheetName,
    filenameBase: `ew_report_${range.startIso}_to_${range.endIso}`,
    pageSize: config.ewReportPageSize
  });

  logger.info('EW Report finished', {
    sheetName: config.ewReportSheetName,
    dbAction: dbResult.action,
    rowCount: dbResult.rowCount,
    headerCount: dbResult.headerCount,
    pageCount: dbResult.pageCount
  });

  return {
    name: 'EW Report',
    sheetName: config.ewReportSheetName,
    dbResult,
    dateRange: range
  };
}
