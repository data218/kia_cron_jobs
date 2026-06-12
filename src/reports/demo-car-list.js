import path from 'node:path';
import { config } from '../config.js';
import { openDemoCarListReport } from '../navigation/kia-menu.js';
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
import { clickSearch, fillDate } from './report-actions.js';

function chunkFileName(chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `demo_car_list_${start}_to_${end}`;
}

function getDemoCarListChunks(today = new Date()) {
  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return getThirtyDayChunks(overrideRange.startDate, overrideRange.endDate);
  }

  if (config.demoCarListBackfillEnabled) {
    const startDate = parseIsoLocalDate(config.demoCarListBackfillStartDate);
    return getThirtyDayChunks(startDate, today);
  }

  const currentMonth = getCurrentMonthToDateRange(today);
  return getThirtyDayChunks(currentMonth.startDate, currentMonth.endDate);
}

async function resolveDemoCarListContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sQueryFromDate', {
    timeout: 90000,
    label: 'Demo Car List Purchase Report From Date'
  });

  await context.locator('#sQueryToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Demo Car List Purchase Report page loaded');
  return context;
}

async function fillDemoCarListDateRange(page, chunk) {
  logger.info('Applying Demo Car List date range', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  await fillDate(page, '#sQueryToDate', chunk.endPortal);
  await fillDate(page, '#sQueryFromDate', chunk.startPortal);
}

export async function downloadDemoCarListReport(page) {
  logger.info('Demo Car List report started');
  await openDemoCarListReport(page);
  const reportContext = await resolveDemoCarListContext(page);

  const today = new Date();
  const chunks = getDemoCarListChunks(today);
  const runDate = toIsoDate(today);
  const chunkDir = path.join(config.reportChunksDir, 'demo-car-list', runDate);
  const exportFiles = [];

  logger.info('Demo Car List date chunks prepared', {
    backfillEnabled: config.demoCarListBackfillEnabled,
    startDate: chunks[0]?.startIso,
    endDate: chunks[chunks.length - 1]?.endIso,
    chunkCount: chunks.length,
    chunkDir
  });

  for (const [index, chunk] of chunks.entries()) {
    logger.info('Processing Demo Car List chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    await fillDemoCarListDateRange(reportContext, chunk);

    await clickSearch(reportContext);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    if (config.demoCarListPostSearchDelayMs > 0) {
      logger.info('Waiting briefly after Demo Car List search before changing page size', {
        delayMs: config.demoCarListPostSearchDelayMs
      });
      await sleep(config.demoCarListPostSearchDelayMs);
    }

    await selectKendoPagerSize(reportContext, config.demoCarListPageSize);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    const chunkPageFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: chunkDir,
      filenameBase: chunkFileName(chunk),
      pageSize: config.demoCarListPageSize
    });
    exportFiles.push(...chunkPageFiles);

    if (index < chunks.length - 1) {
      if (config.demoCarListBetweenChunksDelayMs > 0) {
        logger.info('Waiting after Demo Car List export before entering next date range', {
          delayMs: config.demoCarListBetweenChunksDelayMs
        });
        await sleep(config.demoCarListBetweenChunksDelayMs);
      }
    }
  }

  logger.info('Merging Demo Car List exports', {
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });
  const merged = await mergeExcelFiles(exportFiles);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.demoCarListSheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(chunkDir);

  logger.info('Demo Car List report finished', {
    sheetName: config.demoCarListSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });

  return {
    name: 'Demo Car List',
    sheetName: config.demoCarListSheetName,
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
