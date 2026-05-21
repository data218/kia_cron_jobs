import { config } from '../config.js';
import { openKiaCallCenterComplaintList } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { getRollingThreeMonthRange } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { exportPagedGridToSupabase } from './paged-export.js';
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByLabel
} from './report-actions.js';

async function resolveComplaintContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sCompStartDate', {
    timeout: 90000,
    label: 'Kia Call Center Complaints Start Date'
  });

  await context.locator('#sCompEndDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('KIN Call Center Complaint List page loaded');
  return context;
}

export async function downloadKiaCallCenterComplaintsReport(page) {
  logger.info('Kia Call Center Complaints report started');
  await openKiaCallCenterComplaintList(page);
  const reportContext = await resolveComplaintContext(page);

  await selectKendoDropdownByLabel(reportContext, 'Business Type', 'Service');

  const range = getRollingThreeMonthRange();
  logger.info('Applying complaints date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(reportContext, '#sCompStartDate', range.startPortal);
  await fillDate(reportContext, '#sCompEndDate', range.endPortal);

  logger.info('Searching Kia Call Center Complaints report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Waiting briefly after complaints search before changing page size', {
    delayMs: config.kiaCallCenterComplaintsPostSearchDelayMs
  });
  await sleep(config.kiaCallCenterComplaintsPostSearchDelayMs);

  await selectKendoPagerSize(reportContext, config.kiaCallCenterComplaintsPageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Exporting Kia Call Center Complaints report pages');
  const dbResult = await exportPagedGridToSupabase(reportContext, {
    reportId: 'kia-call-center-complaints',
    sheetName: config.kiaCallCenterComplaintsSheetName,
    filenameBase: `kia_call_center_complaints_${range.endIso}`,
    pageSize: config.kiaCallCenterComplaintsPageSize
  });

  logger.info('Kia Call Center Complaints report finished', {
    sheetName: config.kiaCallCenterComplaintsSheetName,
    dbAction: dbResult.action,
    rowCount: dbResult.rowCount,
    headerCount: dbResult.headerCount,
    pageCount: dbResult.pageCount
  });

  return {
    name: 'Kia Call Center Complaints',
    sheetName: config.kiaCallCenterComplaintsSheetName,
    dbResult,
    dateRange: range
  };
}
