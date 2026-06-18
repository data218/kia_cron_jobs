import path from 'node:path';
import { config } from '../config.js';
import { openOpenRoYearlyReport } from '../navigation/kia-menu.js';
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
import { addDealerCodeToDataset } from './report-metadata.js';
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByInputId,
  selectKendoDropdownByLabel
} from './report-actions.js';

function chunkFileName(chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `demo_job_cards_${start}_to_${end}`;
}

function getDefaultBackfillStartDate(today) {
  return new Date(today.getFullYear(), 0, 1);
}

function getDemoJobCardsChunks(today = new Date()) {
  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return getThirtyDayChunks(overrideRange.startDate, overrideRange.endDate);
  }

  if (config.demoJobCardsBackfillEnabled) {
    const startDate = config.demoJobCardsBackfillStartDate
      ? parseIsoLocalDate(config.demoJobCardsBackfillStartDate)
      : getDefaultBackfillStartDate(today);
    return getThirtyDayChunks(startDate, today);
  }

  const currentMonth = getCurrentMonthToDateRange(today);
  return getThirtyDayChunks(currentMonth.startDate, currentMonth.endDate);
}

async function resolveDemoJobCardsContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sRoDateFromDate', {
    timeout: 90000,
    label: 'Demo Job Cards RO Date From'
  });

  await context.locator('#sRoDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Demo Job Cards Repair Order List page loaded');
  return context;
}

async function selectDemoJobCardsWorkType(page) {
  const value = config.demoJobCardsWorkType;
  const inputIds = ['sWorkType', 'sWrkType', 'workType', 'sWorkTypeCd'];
  const errors = [];

  for (const inputId of inputIds) {
    try {
      await selectKendoDropdownByInputId(page, inputId, value, { timeout: 10000 });
      logger.info('Demo Job Cards work type selected', { inputId, value });
      return;
    } catch (error) {
      errors.push(`${inputId}: ${error.message}`);
    }
  }

  try {
    await selectKendoDropdownByLabel(page, 'Work Type', value, { timeout: 10000 });
    logger.info('Demo Job Cards work type selected by label', { value });
    return;
  } catch (error) {
    errors.push(`label Work Type: ${error.message}`);
  }

  throw new Error(`Could not select Demo Job Cards work type "${value}". Attempts: ${errors.join(' | ')}`);
}

async function fillDemoJobCardsDateRange(page, chunk) {
  logger.info('Applying Demo Job Cards date range', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  // Fill end date first so the DMS validator never sees a temporary over-limit range.
  await fillDate(page, '#sRoDateToDate', chunk.endPortal);
  await fillDate(page, '#sRoDateFromDate', chunk.startPortal);
}

export async function downloadDemoJobCardsReport(page, { dealerCode = 'active' } = {}) {
  logger.info('Demo Job Cards report started', { dealerCode });
  await openOpenRoYearlyReport(page);
  const reportContext = await resolveDemoJobCardsContext(page);

  await selectDemoJobCardsWorkType(reportContext);

  const today = new Date();
  const chunks = getDemoJobCardsChunks(today);
  const runDate = toIsoDate(today);
  const chunkDir = path.join(config.reportChunksDir, 'demo-job-cards', runDate);
  const exportFiles = [];

  logger.info('Demo Job Cards date chunks prepared', {
    backfillEnabled: config.demoJobCardsBackfillEnabled,
    startDate: chunks[0]?.startIso,
    endDate: chunks[chunks.length - 1]?.endIso,
    chunkCount: chunks.length,
    workType: config.demoJobCardsWorkType,
    chunkDir
  });

  for (const [index, chunk] of chunks.entries()) {
    logger.info('Processing Demo Job Cards chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal,
      workType: config.demoJobCardsWorkType
    });

    await fillDemoJobCardsDateRange(reportContext, chunk);

    await clickSearch(reportContext);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    if (config.demoJobCardsPostSearchDelayMs > 0) {
      logger.info('Waiting briefly after Demo Job Cards search before changing page size', {
        delayMs: config.demoJobCardsPostSearchDelayMs
      });
      await sleep(config.demoJobCardsPostSearchDelayMs);
    }

    await selectKendoPagerSize(reportContext, config.demoJobCardsPageSize);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    const chunkPageFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: chunkDir,
      filenameBase: chunkFileName(chunk),
      pageSize: config.demoJobCardsPageSize
    });
    exportFiles.push(...chunkPageFiles);

    if (index < chunks.length - 1) {
      if (config.demoJobCardsBetweenChunksDelayMs > 0) {
        logger.info('Waiting after Demo Job Cards export before entering next date range', {
          delayMs: config.demoJobCardsBetweenChunksDelayMs
        });
        await sleep(config.demoJobCardsBetweenChunksDelayMs);
      }
    }
  }

  logger.info('Merging Demo Job Cards exports', {
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });
  const merged = addDealerCodeToDataset(await mergeExcelFiles(exportFiles), dealerCode);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.demoJobCardsSheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(chunkDir);

  logger.info('Demo Job Cards report finished', {
    sheetName: config.demoJobCardsSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    chunkCount: chunks.length,
    fileCount: exportFiles.length
  });

  return {
    name: 'Demo Job Cards',
    sheetName: config.demoJobCardsSheetName,
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
