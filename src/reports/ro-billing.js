import path from 'node:path';
import { config } from '../config.js';
import { openRoBillingReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import {
  getCurrentMonthToDateRange,
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
import { clickSearch, fillDate, getInputValue } from './report-actions.js';

function chunkFileName(chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `ro_billing_report_${start}_to_${end}`;
}

async function resolveRoBillingContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sBillDateFromDate', {
    timeout: 90000,
    label: 'RO Billing Bill Date From'
  });

  await context.locator('#sBillDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('R/O Billing Report page loaded');
  return context;
}

function getRoBillingChunks() {
  const endDate = new Date();
  const overrideRange = getReportDateOverrideRange();

  if (overrideRange) {
    return {
      mode: 'date-override',
      startDate: overrideRange.startDate,
      endDate: overrideRange.endDate,
      chunks: getThirtyDayChunks(overrideRange.startDate, overrideRange.endDate)
    };
  }

  if (config.historicalBackfillEnabled || config.roBillingBackfillEnabled) {
    const startDate = config.historicalBackfillEnabled
      ? config.historicalBackfillStartDate
      : config.roBillingBackfillStartDate;

    return {
      mode: 'historical-backfill',
      startDate: parseIsoLocalDate(startDate),
      endDate,
      chunks: getThirtyDayChunks(parseIsoLocalDate(startDate), endDate)
    };
  }

  const range = getCurrentMonthToDateRange(endDate);
  return {
    mode: 'current-month',
    startDate: range.startDate,
    endDate: range.endDate,
    chunks: [range]
  };
}

async function applyRoBillingChunk(reportContext, chunk) {
  logger.info('Applying RO Billing date range', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  // Fill end date first so DMS never briefly sees start > end while moving to the next chunk.
  await fillDate(reportContext, '#sBillDateToDate', chunk.endPortal);
  await fillDate(reportContext, '#sBillDateFromDate', chunk.startPortal);

  const actualStart = await getInputValue(reportContext, '#sBillDateFromDate');
  const actualEnd = await getInputValue(reportContext, '#sBillDateToDate');
  logger.info('RO Billing date fields verified before search', {
    expectedStart: chunk.startPortal,
    actualStart,
    expectedEnd: chunk.endPortal,
    actualEnd
  });

  if (actualStart.trim() !== chunk.startPortal || actualEnd.trim() !== chunk.endPortal) {
    throw new Error(
      `RO Billing date fields did not retain expected values. ` +
      `Expected ${chunk.startPortal} - ${chunk.endPortal}, got ${actualStart} - ${actualEnd}`
    );
  }

  logger.info('Searching RO Billing report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });
  if (config.roBillingPostSearchDelayMs > 0) {
    logger.info('Waiting briefly after initial search before changing page size', {
      delayMs: config.roBillingPostSearchDelayMs
    });
    await sleep(config.roBillingPostSearchDelayMs);
  }

  await selectKendoPagerSize(reportContext, config.roBillingPageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });
}

export async function downloadRoBillingReport(page) {
  logger.info('RO Billing report started');
  await openRoBillingReport(page);
  const reportContext = await resolveRoBillingContext(page);

  const chunkPlan = getRoBillingChunks();
  const runDate = toIsoDate(chunkPlan.endDate);
  const chunkDir = path.join(config.reportChunksDir, 'ro-billing', runDate);
  const exportFiles = [];

  logger.info('RO Billing date chunks prepared', {
    mode: chunkPlan.mode,
    startDate: toIsoDate(chunkPlan.startDate),
    endDate: runDate,
    chunkCount: chunkPlan.chunks.length,
    chunkDir
  });

  for (const [index, chunk] of chunkPlan.chunks.entries()) {
    logger.info('Processing RO Billing chunk', {
      chunk: `${index + 1}/${chunkPlan.chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    await applyRoBillingChunk(reportContext, chunk);

    const chunkPageFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: chunkDir,
      filenameBase: chunkFileName(chunk),
      pageSize: config.roBillingPageSize
    });
    exportFiles.push(...chunkPageFiles);

    if (index < chunkPlan.chunks.length - 1) {
      if (config.roBillingBetweenChunksDelayMs > 0) {
        logger.info('Waiting after RO Billing export before entering next date range', {
          delayMs: config.roBillingBetweenChunksDelayMs
        });
        await sleep(config.roBillingBetweenChunksDelayMs);
      }
    }
  }

  logger.info('Merging RO Billing chunks', {
    chunkCount: chunkPlan.chunks.length,
    fileCount: exportFiles.length
  });
  const merged = await mergeExcelFiles(exportFiles);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.roBillingSheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(chunkDir);

  logger.info('RO Billing report finished', {
    sheetName: config.roBillingSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    chunkCount: chunkPlan.chunks.length,
    fileCount: exportFiles.length
  });

  return {
    name: 'RO Billing Report',
    sheetName: config.roBillingSheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length
    },
    dateRange: {
      startIso: toIsoDate(chunkPlan.startDate),
      endIso: runDate
    },
    chunkCount: chunkPlan.chunks.length,
    chunkDir,
    chunkFiles: exportFiles
  };
}
