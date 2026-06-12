import { config } from '../config.js';
import { openKiaCallCenterComplaintList } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { formatDateForPortal, getReportDateOverrideRange, getRollingThreeMonthRange, parseIsoLocalDate, toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { exportPagedGridToSupabase } from './paged-export.js';
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByLabel
} from './report-actions.js';

const COMPLAINT_EXPORT_HEADERS = [
  'No.',
  'Status',
  'Complaint No.',
  'SR No.',
  'Type',
  'Cust Name',
  'Mobile No.',
  'VIN No.',
  'Dealer Name',
  'Dealer Code',
  'Region',
  'Complaint Date',
  'Pending Days',
  'CC Reopen Days',
  'CC Reopen Date',
  'Hold Days',
  'Hold Status',
  'Dealer Resolving Date',
  'Resolving Date',
  'Resolved By Dealer',
  'Close Date',
  'Complaint Closing Time',
  'RCA Date',
  'Closed By',
  'Closed By Name',
  'Complaint Sub Source',
  'Complaint Remarks',
  'Service Engineer/Advisor Observation',
  'Complaint Type',
  'SR Area',
  'SR Sub Area',
  'SR Type',
  'Vehicle Model',
  'Varient',
  'Part Number',
  'Order Number',
  'Order Date',
  'Dealer SR Area',
  'Dealer SR Sub Area',
  'Delaer SR Type',
  'ASFM SR Area',
  'ASFM SR Sub Area',
  'ASFM SR Type',
  'Pending Reason'
];

async function resolveComplaintContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sCompStartDate', {
    timeout: 90000,
    label: 'Kia Call Center Complaints Start Date'
  });

  await context.locator('#sCompEndDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('KIN Call Center Complaint List page loaded');
  return context;
}

function getPreviousYearJanFirstRange(today = new Date()) {
  const startDate = config.historicalBackfillEnabled
    ? parseIsoLocalDate(config.historicalBackfillStartDate)
    : new Date(today.getFullYear() - 1, 0, 1);
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

export async function downloadKiaCallCenterComplaintsReport(page) {
  logger.info('Kia Call Center Complaints report started');
  await openKiaCallCenterComplaintList(page);
  const reportContext = await resolveComplaintContext(page);

  await selectKendoDropdownByLabel(reportContext, 'Business Type', 'Service');

  const range = getReportDateOverrideRange() ?? ((config.historicalBackfillEnabled || config.kiaCallCenterComplaintsNoSearchBackfill)
    ? getPreviousYearJanFirstRange()
    : getRollingThreeMonthRange());

  logger.info('Applying complaints date range', {
    startDate: range.startPortal,
    endDate: config.kiaCallCenterComplaintsNoSearchBackfill ? 'unchanged portal default' : range.endPortal,
    noSearchBackfill: config.kiaCallCenterComplaintsNoSearchBackfill
  });

  await fillDate(reportContext, '#sCompStartDate', range.startPortal);

  if (config.kiaCallCenterComplaintsNoSearchBackfill) {
    logger.info('Skipping complaints end-date fill and Search button for temporary no-search backfill');
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });
  } else {
    await fillDate(reportContext, '#sCompEndDate', range.endPortal);

    logger.info('Searching Kia Call Center Complaints report');
    await clickSearch(reportContext);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });
  }

  if (config.kiaCallCenterComplaintsPostSearchDelayMs > 0) {
    logger.info('Waiting briefly after complaints search before changing page size', {
      delayMs: config.kiaCallCenterComplaintsPostSearchDelayMs
    });
    await sleep(config.kiaCallCenterComplaintsPostSearchDelayMs);
  }

  await selectKendoPagerSize(reportContext, config.kiaCallCenterComplaintsPageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Exporting Kia Call Center Complaints report pages');
  const dbResult = await exportPagedGridToSupabase(reportContext, {
    reportId: 'kia-call-center-complaints',
    sheetName: config.kiaCallCenterComplaintsSheetName,
    filenameBase: `kia_call_center_complaints_${range.endIso}`,
    pageSize: config.kiaCallCenterComplaintsPageSize,
    forcedHeaders: COMPLAINT_EXPORT_HEADERS
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
