import path from 'node:path';
import { config } from '../config.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { clearRelationalTable } from '../supabase/relational-store.js';
import {
  getCalendarMonthRanges,
  getCurrentMonthToDateRange,
  getRollingThreeMonthRange,
  getReportDateOverrideRange,
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
import { addDealerCodeToDataset } from './report-metadata.js';
import { clickSearch, fillDate, getInputValue } from './report-actions.js';

function chunkFileName(reportId, chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `${reportId}_${start}_to_${end}`;
}

function isHistoricalMode(mode, reportId) {
  return mode === `${reportId}-historical`;
}

function getChunkPlan({ reportId, backfillEnabled, backfillStartDate }) {
  const endDate = new Date();
  const overrideRange = getReportDateOverrideRange();

  if (overrideRange) {
    return {
      mode: 'date-override',
      startDate: overrideRange.startDate,
      endDate: overrideRange.endDate,
      chunks: getCalendarMonthRanges(overrideRange.startDate, overrideRange.endDate)
    };
  }

  if (config.historicalBackfillEnabled || backfillEnabled) {
    const startValue = config.historicalBackfillEnabled
      ? config.historicalBackfillStartDate
      : backfillStartDate;
    const startDate = parseIsoLocalDate(startValue);

    return {
      mode: 'historical-backfill',
      startDate,
      endDate,
      chunks: getCalendarMonthRanges(startDate, endDate)
    };
  }

  // Daily rolling 3-month fetch for booking, enquiry, purchase and receipt reports
  if (reportId === 'kia-booking-report' || reportId === 'kia-enquiry-report' || reportId === 'kia-purchase-report' || reportId === 'kia-receipt-report') {
    const rollingRange = getRollingThreeMonthRange(endDate);
    return {
      mode: 'rolling-three-months',
      startDate: rollingRange.startDate,
      endDate: rollingRange.endDate,
      chunks: getCalendarMonthRanges(rollingRange.startDate, rollingRange.endDate)
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

async function resolveReportContext(page, selector, name) {
  const context = await findContextWithVisibleSelector(page, selector, {
    timeout: 90000,
    label: `${name} start date`
  });

  logger.info('Kia MIS report page loaded', {
    report: name,
    selector
  });

  return context;
}

async function applyChunk(reportContext, chunk, {
  name,
  startSelector,
  endSelector,
  pageSize,
  postSearchDelayMs,
  prepareChunk
}) {
  logger.info('Applying Kia MIS report date range', {
    report: name,
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  if (prepareChunk) {
    await prepareChunk(reportContext, chunk);
  }

  await fillDate(reportContext, endSelector, chunk.endPortal);
  await fillDate(reportContext, startSelector, chunk.startPortal);

  const actualStart = await getInputValue(reportContext, startSelector);
  const actualEnd = await getInputValue(reportContext, endSelector);
  logger.info('Kia MIS report date fields verified before search', {
    report: name,
    expectedStart: chunk.startPortal,
    actualStart,
    expectedEnd: chunk.endPortal,
    actualEnd
  });

  if (actualStart.trim() !== chunk.startPortal || actualEnd.trim() !== chunk.endPortal) {
    throw new Error(
      `${name} date fields did not retain expected values. ` +
      `Expected ${chunk.startPortal} - ${chunk.endPortal}, got ${actualStart} - ${actualEnd}`
    );
  }

  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  if (postSearchDelayMs > 0) {
    logger.info('Waiting briefly after Kia MIS search before changing page size', {
      report: name,
      delayMs: postSearchDelayMs
    });
    await sleep(postSearchDelayMs);
  }

  await selectKendoPagerSize(reportContext, pageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });
}

export async function downloadKiaMonthlySalesMisReport(page, {
  dealerCode = 'active',
  mode = 'configured',
  reportId,
  name,
  openReport,
  startSelector,
  endSelector,
  sheetName,
  pageSize,
  postSearchDelayMs,
  betweenChunksDelayMs,
  backfillStartDate,
  prepareContext,
  prepareChunk,
  clearTableBeforeSave = false
}) {
  logger.info('Kia MIS monthly report started', {
    report: name,
    reportId,
    dealerCode,
    mode
  });

  await openReport(page);
  const reportContext = await resolveReportContext(page, startSelector, name);

  if (prepareContext) {
    await prepareContext(reportContext);
  }

  const chunkPlan = getChunkPlan({
    reportId,
    backfillEnabled: isHistoricalMode(mode, reportId),
    backfillStartDate
  });
  const runDate = toIsoDate(chunkPlan.endDate);
  const chunkDir = path.join(config.reportChunksDir, reportId, runDate);
  const exportFiles = [];

  logger.info('Kia MIS monthly report chunks prepared', {
    report: name,
    mode: chunkPlan.mode,
    startDate: toIsoDate(chunkPlan.startDate),
    endDate: runDate,
    chunkCount: chunkPlan.chunks.length,
    chunkDir
  });

  for (const [index, chunk] of chunkPlan.chunks.entries()) {
    logger.info('Processing Kia MIS monthly report chunk', {
      report: name,
      chunk: `${index + 1}/${chunkPlan.chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    await applyChunk(reportContext, chunk, {
      name,
      startSelector,
      endSelector,
      pageSize,
      postSearchDelayMs,
      prepareChunk
    });

    const chunkPageFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: chunkDir,
      filenameBase: chunkFileName(reportId, chunk),
      pageSize
    });
    exportFiles.push(...chunkPageFiles);

    if (index < chunkPlan.chunks.length - 1 && betweenChunksDelayMs > 0) {
      logger.info('Waiting before entering next Kia MIS monthly report range', {
        report: name,
        delayMs: betweenChunksDelayMs
      });
      await sleep(betweenChunksDelayMs);
    }
  }

  const rawMerged = exportFiles.length ? await mergeExcelFiles(exportFiles) : { headers: [], rows: [] };
  // Only inject dealer_code column when doing multi-dealer runs.
  // For single-dealer (default) runs the report already contains both dealer codes.
  const merged = (dealerCode && dealerCode !== 'active')
    ? addDealerCodeToDataset(rawMerged, dealerCode)
    : rawMerged;

  if (clearTableBeforeSave && merged.rows.length > 0) {
    logger.info('Clearing existing relational table before saving fresh data', {
      report: name,
      sheetName
    });
    await clearRelationalTable(sheetName);
  }

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(chunkDir);

  logger.info('Kia MIS monthly report finished', {
    report: name,
    sheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    chunkCount: chunkPlan.chunks.length,
    fileCount: exportFiles.length
  });

  return {
    name,
    sheetName,
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
