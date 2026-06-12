import path from 'node:path';
import { config } from '../config.js';
import { openEwReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { formatDateForPortal, getCurrentMonthToDateRange, getReportDateOverrideRange, getThirtyDayChunks, parseIsoLocalDate, toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { cleanupReportExportDir, exportAllGridPagesToFiles, mergeExcelFiles } from './paged-export.js';
import { addDealerCodeToDataset } from './report-metadata.js';
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
  await fillDate(page, '#sRegDateFromDate', range.startPortal);
}

export async function downloadEwReport(page, { dealerCode = 'active' } = {}) {
  logger.info('EW Report started', { dealerCode });
  await openEwReport(page);
  const reportContext = await resolveEwReportContext(page);

  const overrideRange = getReportDateOverrideRange();
  const range = overrideRange ?? (config.historicalBackfillEnabled
    ? {
        startDate: parseIsoLocalDate(config.historicalBackfillStartDate),
        endDate: new Date()
      }
    : getCurrentMonthToDateRange());
  if (config.historicalBackfillEnabled && !overrideRange) {
    range.startPortal = formatDateForPortal(range.startDate);
    range.endPortal = formatDateForPortal(range.endDate);
    range.startIso = toIsoDate(range.startDate);
    range.endIso = toIsoDate(range.endDate);
  }

  const chunks = (config.historicalBackfillEnabled || overrideRange)
    ? getThirtyDayChunks(range.startDate, range.endDate)
    : [range];
  const exportDir = path.join(config.reportChunksDir, 'ew-report', toIsoDate(new Date()));
  const exportFiles = [];

  logger.info('EW Report date chunks prepared', {
    mode: config.historicalBackfillEnabled ? 'historical-backfill' : 'current-month',
    startDate: range.startIso,
    endDate: range.endIso,
    chunkCount: chunks.length,
    exportDir
  });

  for (const [index, chunk] of chunks.entries()) {
    await fillEwDateRange(reportContext, chunk);

    logger.info('Searching EW Report chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });
    await clickSearch(reportContext);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    if (config.ewReportPostSearchDelayMs > 0) {
      logger.info('Waiting briefly after EW Report search before changing page size', {
        delayMs: config.ewReportPostSearchDelayMs
      });
      await sleep(config.ewReportPostSearchDelayMs);
    }

    await selectKendoPagerSize(reportContext, config.ewReportPageSize);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    logger.info('Exporting EW Report chunk pages');
    const chunkFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: exportDir,
      filenameBase: `ew_report_${chunk.startIso}_to_${chunk.endIso}`,
      pageSize: config.ewReportPageSize
    });
    exportFiles.push(...chunkFiles);
  }

  const merged = addDealerCodeToDataset(await mergeExcelFiles(exportFiles), dealerCode);
  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.ewReportSheetName,
    headers: merged.headers,
    rows: merged.rows
  });
  await cleanupReportExportDir(exportDir);

  logger.info('EW Report finished', {
    sheetName: config.ewReportSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: dbResult.headerCount,
    pageCount: exportFiles.length
  });

  return {
    name: 'EW Report',
    sheetName: config.ewReportSheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length,
      pageCount: exportFiles.length
    },
    dateRange: range
  };
}
