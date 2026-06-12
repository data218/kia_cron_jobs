import path from 'node:path';
import { config } from '../config.js';
import { openPsfYearlyReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { formatDateForPortal, getReportDateOverrideRange, getRollingTwoMonthRange, getThirtyDayChunks, parseIsoLocalDate, toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import {
  cleanupReportExportDir,
  exportAllGridPagesToFiles,
  mergeExcelFiles
} from './paged-export.js';
import {
  clickSearch,
  fillDate
} from './report-actions.js';

function psfChunkFileName(chunk) {
  return `psf_yearly_${chunk.startIso}_to_${chunk.endIso}`;
}

async function resolvePsfYearlyContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sRODateFromDate', {
    timeout: 90000,
    label: 'PSF Yearly RO Date From'
  });

  await context.locator('#sRODateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Post Service Follow Up Report page loaded');
  return context;
}

async function fillPsfDateRange(page, range) {
  logger.info('Applying PSF Yearly date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(page, '#sRODateToDate', range.endPortal);
  await fillDate(page, '#sRODateFromDate', range.startPortal);
}

export async function downloadPsfYearlyReport(page) {
  logger.info('PSF Yearly report started');
  await openPsfYearlyReport(page);
  const reportContext = await resolvePsfYearlyContext(page);

  const range = getReportDateOverrideRange() ?? (config.historicalBackfillEnabled
    ? {
        startDate: parseIsoLocalDate(config.historicalBackfillStartDate),
        endDate: new Date()
      }
    : getRollingTwoMonthRange());
  if (config.historicalBackfillEnabled && !getReportDateOverrideRange()) {
    range.startPortal = formatDateForPortal(range.startDate);
    range.endPortal = formatDateForPortal(range.endDate);
    range.startIso = toIsoDate(range.startDate);
    range.endIso = toIsoDate(range.endDate);
  }
  const chunks = getThirtyDayChunks(range.startDate, range.endDate);
  const runDate = toIsoDate(new Date());
  const exportDir = path.join(config.reportChunksDir, 'psf-yearly', runDate);
  const exportFiles = [];

  logger.info('PSF Yearly date chunks prepared', {
    startDate: range.startPortal,
    endDate: range.endPortal,
    chunkCount: chunks.length,
    exportDir
  });

  for (const [index, chunk] of chunks.entries()) {
    logger.info('Processing PSF Yearly chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    await fillPsfDateRange(reportContext, chunk);

    logger.info('Searching PSF Yearly report chunk');
    await clickSearch(reportContext);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    if (config.psfYearlyPostSearchDelayMs > 0) {
      logger.info('Waiting briefly after PSF Yearly search before changing page size', {
        delayMs: config.psfYearlyPostSearchDelayMs
      });
      await sleep(config.psfYearlyPostSearchDelayMs);
    }

    await selectKendoPagerSize(reportContext, config.psfYearlyPageSize);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    logger.info('Exporting PSF Yearly chunk pages');
    const chunkPageFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: exportDir,
      filenameBase: psfChunkFileName(chunk),
      pageSize: config.psfYearlyPageSize
    });
    exportFiles.push(...chunkPageFiles);

    if (index < chunks.length - 1) {
      if (config.psfYearlyBetweenChunksDelayMs > 0) {
        logger.info('Waiting after PSF Yearly export before entering next date range', {
          delayMs: config.psfYearlyBetweenChunksDelayMs
        });
        await sleep(config.psfYearlyBetweenChunksDelayMs);
      }
    }
  }

  logger.info('Merging PSF Yearly exports', {
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });
  const merged = await mergeExcelFiles(exportFiles);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.psfYearlySheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(exportDir);

  logger.info('PSF Yearly report finished', {
    sheetName: config.psfYearlySheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });

  return {
    name: 'PSF Yearly',
    sheetName: config.psfYearlySheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length,
      chunkCount: chunks.length,
      fileCount: exportFiles.length
    },
    dateRange: range,
    chunks
  };
}
