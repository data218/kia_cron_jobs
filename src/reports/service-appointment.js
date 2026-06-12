import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  openServiceAppointmentListReport,
  openServiceAppointmentListReportFromServiceMis
} from '../navigation/kia-menu.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import {
  formatDateForPortal,
  getReportDateOverrideRange,
  getThirtyDayChunks,
  parseIsoLocalDate,
  toIsoDate
} from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import {
  cleanupReportExportDir,
  exportAllGridPagesToFiles,
  mergeExcelFiles
} from './paged-export.js';
import { clickSearch } from './report-actions.js';
import { addDealerCodeToDataset } from './report-metadata.js';

const START_DATE_SELECTORS = [
  '#sBkngFromDate',
  '#sAppointFromDate',
  '#sAppointmentFromDate',
  '#sApptFromDate',
  '#sAppointDateFromDate',
  '#sAppointmentDateFromDate',
  '#sSvcBookingFromDate',
  '#sBookingFromDate',
  '#sQueryFromDate',
  'xpath=//dt[contains(normalize-space(.),"Appointment Date") or contains(normalize-space(.),"Appointement Date")]/following-sibling::dd[1]//input[not(@type="hidden")][1]',
  'xpath=//span[contains(normalize-space(.),"Appointment Date") or contains(normalize-space(.),"Appointement Date")]/ancestor::dt[1]/following-sibling::dd[1]//input[not(@type="hidden")][1]'
];

const END_DATE_SELECTORS = [
  '#sBkngToDate',
  '#sAppointToDate',
  '#sAppointmentToDate',
  '#sApptToDate',
  '#sAppointDateToDate',
  '#sAppointmentDateToDate',
  '#sSvcBookingToDate',
  '#sBookingToDate',
  '#sQueryToDate',
  'xpath=//dt[contains(normalize-space(.),"Appointment Date") or contains(normalize-space(.),"Appointement Date")]/following-sibling::dd[1]//input[not(@type="hidden")][2]',
  'xpath=//span[contains(normalize-space(.),"Appointment Date") or contains(normalize-space(.),"Appointement Date")]/ancestor::dt[1]/following-sibling::dd[1]//input[not(@type="hidden")][2]'
];

async function isVisibleInContext(context, selector) {
  return context.locator(selector).first().isVisible({ timeout: 50 }).catch(() => false);
}

async function findContextWithAnyVisibleSelector(page, selectors, { timeout = 90000, label }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    for (const context of [page, ...page.frames().filter(frame => frame !== page.mainFrame())]) {
      for (const selector of selectors) {
        if (await isVisibleInContext(context, selector)) {
          logger.info('Found selector for Service Appointment report', {
            label,
            selector,
            frameName: typeof context.name === 'function' ? context.name() : '',
            frameUrl: typeof context.url === 'function' ? context.url() : page.url()
          });
          return { context, selector };
        }
      }
    }

    await sleep(50);
  }

  const frames = page.frames().map(frame => ({
    name: frame.name(),
    url: frame.url()
  }));
  throw new Error(`Could not find Service Appointment ${label} field. Frames: ${JSON.stringify(frames)}`);
}

async function fillDateLocator(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 30000 });
  try {
    await locator.fill('');
    await locator.fill(value);
  } catch {
    await locator.evaluate((element, nextValue) => {
      element.removeAttribute('readonly');
      element.value = nextValue;
    }, value);
  }

  await locator.evaluate((element, nextValue) => {
    element.removeAttribute('readonly');
    element.value = nextValue;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));

    const win = element.ownerDocument?.defaultView;
    const jquery = win?.jQuery ?? win?.$;
    if (jquery) {
      const widget = jquery(element).data('kendoDatePicker') ??
        jquery(element).data('kendoMaskedTextBox') ??
        jquery(element).data('kendoExtMaskedDatePicker') ??
        jquery(element).data('extmaskeddatepicker');
      if (widget?.value) {
        widget.value(nextValue);
      }
      if (widget?.trigger) {
        widget.trigger('change');
      }
    }
  }, value);

  await locator.press('Tab').catch(() => {});
}

function getSingleDayRange(today = new Date()) {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return {
    startDate: date,
    endDate: date,
    startPortal: formatDateForPortal(date),
    endPortal: formatDateForPortal(date),
    startIso: toIsoDate(date),
    endIso: toIsoDate(date)
  };
}

function getCurrentMonthRange(today = new Date()) {
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1);
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

function markerPath(dealerCode) {
  const safeDealer = String(dealerCode || 'active')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '_') || 'ACTIVE';
  return path.join(config.tempDir, `service-appointment-backfill-${safeDealer}.json`);
}

async function hasCompletedInitialBackfill(dealerCode) {
  if (config.serviceAppointmentBackfillEnabled) {
    return false;
  }

  const marker = markerPath(dealerCode);
  try {
    await fs.access(marker);
    return true;
  } catch {
    return false;
  }
}

async function writeInitialBackfillMarker(dealerCode, result) {
  const marker = markerPath(dealerCode);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, JSON.stringify({
    dealerCode: dealerCode || 'active',
    completedAt: new Date().toISOString(),
    rowCount: result.rowCount,
    addedRowCount: result.addedRowCount,
    duplicateRowCount: result.duplicateRowCount
  }, null, 2));
  logger.info('Service Appointment initial backfill marker written', {
    dealerCode,
    marker
  });
}

async function getServiceAppointmentChunks(dealerCode, today = new Date()) {
  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return {
      mode: 'date-override',
      chunks: getThirtyDayChunks(overrideRange.startDate, overrideRange.endDate)
    };
  }

  if (config.serviceAppointmentBackfillEnabled && !await hasCompletedInitialBackfill(dealerCode)) {
    const startDate = parseIsoLocalDate(config.serviceAppointmentBackfillStartDate);
    return {
      mode: 'initial-backfill',
      chunks: getThirtyDayChunks(startDate, today)
    };
  }

  const currentMonth = getCurrentMonthRange(today);
  return {
    mode: 'current-month-full',
    chunks: getThirtyDayChunks(currentMonth.startDate, currentMonth.endDate)
  };
}

function chunkFileName(chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `service_appointment_${start}_to_${end}`;
}

async function openServiceAppointmentReportWithFallback(page) {
  try {
    await openServiceAppointmentListReport(page);
  } catch (error) {
    logger.warn('Service Appointment List did not open from Service menu; trying Service MIS fallback', {
      error: error.message
    });
    await openServiceAppointmentListReportFromServiceMis(page);
  }
}

async function resolveServiceAppointmentContext(page) {
  const start = await findContextWithAnyVisibleSelector(page, START_DATE_SELECTORS, {
    timeout: 90000,
    label: 'Appointment start date'
  });
  const end = await findContextWithAnyVisibleSelector(page, END_DATE_SELECTORS, {
    timeout: 30000,
    label: 'Appointment end date'
  });

  if (start.context !== end.context) {
    logger.warn('Service Appointment date fields resolved in different contexts; using start context', {
      startSelector: start.selector,
      endSelector: end.selector
    });
  }

  logger.info('Service Appointment List page loaded', {
    startSelector: start.selector,
    endSelector: end.selector
  });

  return {
    context: start.context,
    startSelector: start.selector,
    endSelector: end.selector
  };
}

async function fillServiceAppointmentDateRange(reportContext, chunk) {
  logger.info('Applying Service Appointment date range', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  const endInput = reportContext.context.locator(reportContext.endSelector).first();
  const startInput = reportContext.context.locator(reportContext.startSelector).first();

  await fillDateLocator(endInput, chunk.endPortal);
  await fillDateLocator(startInput, chunk.startPortal);
}

async function hasNoServiceAppointmentRecords(reportContext) {
  const noRecordSelectors = [
    '.k-grid-norecords',
    'text=/No Records found/i',
    'text=/No records/i',
    'text=/No data/i',
    'text=/No result/i'
  ];

  for (const selector of noRecordSelectors) {
    if (await reportContext.context.locator(selector).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }
  }

  return false;
}

export async function downloadServiceAppointmentReport(page, { dealerCode = 'active' } = {}) {
  logger.info('Service Appointment report started', { dealerCode });
  await openServiceAppointmentReportWithFallback(page);
  const reportContext = await resolveServiceAppointmentContext(page);

  const today = new Date();
  const { mode, chunks } = await getServiceAppointmentChunks(dealerCode, today);
  const runDate = toIsoDate(today);
  const chunkDir = path.join(config.reportChunksDir, 'service-appointment', runDate);
  const exportFiles = [];

  logger.info('Service Appointment date chunks prepared', {
    dealerCode,
    mode,
    startDate: chunks[0]?.startIso,
    endDate: chunks[chunks.length - 1]?.endIso,
    chunkCount: chunks.length,
    chunkDir
  });

  for (const [index, chunk] of chunks.entries()) {
    logger.info('Processing Service Appointment chunk', {
      dealerCode,
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    await fillServiceAppointmentDateRange(reportContext, chunk);

    await clickSearch(reportContext.context);
    await waitForKendoGridIdle(reportContext.context, { timeout: 120000 });

    if (config.serviceAppointmentPostSearchDelayMs > 0) {
      logger.info('Waiting briefly after Service Appointment search before changing page size', {
        delayMs: config.serviceAppointmentPostSearchDelayMs
      });
      await sleep(config.serviceAppointmentPostSearchDelayMs);
    }

    if (await hasNoServiceAppointmentRecords(reportContext)) {
      logger.info('Service Appointment chunk has no records; skipping export', {
        dealerCode,
        chunk: `${index + 1}/${chunks.length}`,
        startDate: chunk.startIso,
        endDate: chunk.endIso
      });
      continue;
    }

    await selectKendoPagerSize(reportContext.context, config.serviceAppointmentPageSize);
    await waitForKendoGridIdle(reportContext.context, { timeout: 120000 });

    const chunkPageFiles = await exportAllGridPagesToFiles(reportContext.context, {
      outputDir: chunkDir,
      filenameBase: chunkFileName(chunk),
      pageSize: config.serviceAppointmentPageSize
    });
    exportFiles.push(...chunkPageFiles);

    if (index < chunks.length - 1) {
      if (config.serviceAppointmentBetweenChunksDelayMs > 0) {
        logger.info('Waiting after Service Appointment export before entering next date range', {
          delayMs: config.serviceAppointmentBetweenChunksDelayMs
        });
        await sleep(config.serviceAppointmentBetweenChunksDelayMs);
      }
    }
  }

  logger.info('Merging Service Appointment exports', {
    dealerCode,
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });

  if (!exportFiles.length) {
    await cleanupReportExportDir(chunkDir);

    if (mode === 'initial-backfill') {
      await writeInitialBackfillMarker(dealerCode, {
        rowCount: 0,
        addedRowCount: 0,
        duplicateRowCount: 0
      });
    }

    logger.info('Service Appointment report finished with no records to export', {
      dealerCode,
      sheetName: config.serviceAppointmentSheetName,
      chunkCount: chunks.length
    });

    return {
      name: 'Service Appointment',
      sheetName: config.serviceAppointmentSheetName,
      dbResult: {
        action: 'no-records',
        rowCount: 0,
        headerCount: 0,
        chunkCount: chunks.length,
        pageCount: 0,
        addedRowCount: 0,
        duplicateRowCount: 0
      },
      chunkCount: chunks.length,
      chunkDir,
      chunkFiles: []
    };
  }

  const merged = addDealerCodeToDataset(await mergeExcelFiles(exportFiles), dealerCode);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.serviceAppointmentSheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(chunkDir);

  if (mode === 'initial-backfill' && !dbResult.failed) {
    await writeInitialBackfillMarker(dealerCode, {
      rowCount: merged.rows.length,
      addedRowCount: dbResult.addedRowCount,
      duplicateRowCount: dbResult.duplicateRowCount
    });
  }

  logger.info('Service Appointment report finished', {
    dealerCode,
    sheetName: config.serviceAppointmentSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });

  return {
    name: 'Service Appointment',
    sheetName: config.serviceAppointmentSheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length
    },
    chunkCount: chunks.length,
    chunkDir,
    chunkFiles: exportFiles
  };
}
