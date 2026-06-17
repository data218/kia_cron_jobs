import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { openOpenRoYearlyReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { getReportDateOverrideRange, getThirtyDayChunks, parseIsoLocalDate, toIsoDate } from '../utils/date-range.js';
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
  fillDateRange,
  getInputValue,
  selectKendoDropdownByInputId
} from './report-actions.js';

function chunkFileName(chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `open_ro_${start}_to_${end}`;
}

async function findExistingChunkExports(chunkDir, filenameBase) {
  const files = await fs.readdir(chunkDir).catch(error => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  return files
    .filter(file => file === `${filenameBase}.xlsx` || file.startsWith(`${filenameBase}_page_`))
    .filter(file => file.toLowerCase().endsWith('.xlsx'))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map(file => path.join(chunkDir, file));
}

async function resolveOpenRoContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sRoDateFromDate', {
    timeout: 90000,
    label: 'Open RO Yearly RO Date From'
  });

  await context.locator('#sRoDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#sROStatus').first().waitFor({ state: 'attached', timeout: 30000 });
  logger.info('Repair Order List page loaded');
  return context;
}

async function fillOpenRoDateRange(page, chunk) {
  logger.info('Applying Open RO date range', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  // Use fillDateRange to set both dates before triggering Kendo validation events.
  // This prevents the page from clearing fields due to intermediate range validation
  // when moving backward in time.
  await fillDateRange(page, '#sRoDateFromDate', '#sRoDateToDate', chunk.startPortal, chunk.endPortal);

  const actualStart = await getInputValue(page, '#sRoDateFromDate');
  const actualEnd = await getInputValue(page, '#sRoDateToDate');
  logger.info('Open RO date fields verified before search', {
    expectedStart: chunk.startPortal,
    actualStart,
    expectedEnd: chunk.endPortal,
    actualEnd
  });

  if (actualStart.trim() !== chunk.startPortal || actualEnd.trim() !== chunk.endPortal) {
    throw new Error(
      `Open RO date fields did not retain expected values. ` +
      `Expected ${chunk.startPortal} - ${chunk.endPortal}, got ${actualStart} - ${actualEnd}`
    );
  }
}

export async function downloadOpenRoYearlyReport(page) {
  logger.info('Open RO Yearly report started');
  await openOpenRoYearlyReport(page);
  const reportContext = await resolveOpenRoContext(page);

  await selectKendoDropdownByInputId(reportContext, 'sROStatus', 'Open');

  const overrideRange = getReportDateOverrideRange();
  const startDate = overrideRange?.startDate ?? parseIsoLocalDate(
    config.historicalBackfillEnabled
      ? config.historicalBackfillStartDate
      : config.openRoYearlyStartDate
  );
  const endDate = overrideRange?.endDate ?? new Date();
  const chunks = getThirtyDayChunks(startDate, endDate).reverse();
  const runDate = toIsoDate(endDate);
  const chunkDir = path.join(config.reportChunksDir, 'open-ro-yearly', runDate);
  const exportFiles = [];

  logger.info('Open RO Yearly date chunks prepared', {
    startDate: toIsoDate(startDate),
    endDate: runDate,
    chunkCount: chunks.length,
    chunkDir
  });

  for (const [index, chunk] of chunks.entries()) {
    logger.info('Processing Open RO chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    const filenameBase = chunkFileName(chunk);
    const existingChunkFiles = await findExistingChunkExports(chunkDir, filenameBase);
    if (existingChunkFiles.length) {
      logger.info('Reusing existing Open RO chunk exports', {
        chunk: `${index + 1}/${chunks.length}`,
        filenameBase,
        fileCount: existingChunkFiles.length
      });
      exportFiles.push(...existingChunkFiles);
      continue;
    }

    await fillOpenRoDateRange(reportContext, chunk);

    await clickSearch(reportContext);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    if (config.openRoYearlyPostSearchDelayMs > 0) {
      logger.info('Waiting briefly after Open RO search before changing page size', {
        delayMs: config.openRoYearlyPostSearchDelayMs
      });
      await sleep(config.openRoYearlyPostSearchDelayMs);
    }

    await selectKendoPagerSize(reportContext, config.openRoYearlyPageSize);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    const chunkPageFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: chunkDir,
      filenameBase,
      pageSize: config.openRoYearlyPageSize
    });
    exportFiles.push(...chunkPageFiles);

    if (index < chunks.length - 1) {
      if (config.openRoYearlyBetweenChunksDelayMs > 0) {
        logger.info('Waiting after Open RO export before entering next date range', {
          delayMs: config.openRoYearlyBetweenChunksDelayMs
        });
        await sleep(config.openRoYearlyBetweenChunksDelayMs);
      }
    }
  }

  logger.info('Merging Open RO chunks', {
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });

  if (!exportFiles.length) {
    logger.info('No Open RO data found across any date chunks; skipping database save');
    await cleanupReportExportDir(chunkDir).catch(() => {});
    return {
      name: 'Open RO Yearly',
      sheetName: config.openRoYearlySheetName,
      dbResult: {
        action: 'skipped_no_data',
        rowCount: 0,
        headerCount: 0
      },
      chunkCount: chunks.length,
      chunkDir,
      chunkFiles: []
    };
  }

  const merged = await mergeExcelFiles(exportFiles);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.openRoYearlySheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(chunkDir);

  logger.info('Open RO Yearly report finished', {
    sheetName: config.openRoYearlySheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });

  return {
    name: 'Open RO Yearly',
    sheetName: config.openRoYearlySheetName,
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
