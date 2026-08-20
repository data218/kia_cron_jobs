import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

import { openHmilReceiptReport } from '../navigation/hmil-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import {
  getReportDateOverrideRange,
  getThirtyDayChunks,
  parseIsoLocalDate,
  toIsoDate
} from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSizeWithPreferredFallback, waitForKendoGridIdle } from './grid.js';
import {
  cleanupReportExportDir,
  exportAllGridPagesToFiles,
  mergeExcelFiles
} from './paged-export.js';
import { addSourceDealerCodeToDataset } from './report-metadata.js';
import { clickSearch, fillDate, getInputValue } from './report-actions.js';

function FiveYearsAgoDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 5);
  return date;
}

function chunkFileName(chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `hyundai_receipt_report_${start}_to_${end}`;
}

export function getHyundaiReceiptReportChunks(today = new Date()) {
  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return getThirtyDayChunks(overrideRange.startDate, overrideRange.endDate);
  }

  const startDateStr = config.hyundaiReceiptReportBackfillStartDate || config.historicalBackfillStartDate;
  const startDate = startDateStr ? parseIsoLocalDate(startDateStr) : FiveYearsAgoDate();

  return getThirtyDayChunks(startDate, today);
}

async function resolveHyundaiReceiptReportContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sQueryFromDate', {
    timeout: 90000,
    label: 'Hyundai Receipt Report Date From'
  });

  await context.locator('#sQueryToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Hyundai Receipt Report page loaded');
  return context;
}

async function applyHyundaiReceiptReportChunk(reportContext, chunk) {
  logger.info('Applying Hyundai Receipt Report date range', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  await fillDate(reportContext, '#sQueryToDate', chunk.endPortal);
  await fillDate(reportContext, '#sQueryFromDate', chunk.startPortal);

  const actualStart = await getInputValue(reportContext, '#sQueryFromDate');
  const actualEnd = await getInputValue(reportContext, '#sQueryToDate');
  logger.info('Hyundai Receipt Report date fields verified before search', {
    expectedStart: chunk.startPortal,
    actualStart,
    expectedEnd: chunk.endPortal,
    actualEnd
  });

  if (actualStart.trim() !== chunk.startPortal || actualEnd.trim() !== chunk.endPortal) {
    throw new Error(
      `Hyundai Receipt Report date fields did not retain expected values. ` +
      `Expected ${chunk.startPortal} - ${chunk.endPortal}, got ${actualStart} - ${actualEnd}`
    );
  }

  logger.info('Searching Hyundai Receipt Report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  const postSearchDelay = config.hyundaiReceiptReportPostSearchDelayMs || 5000;
  if (postSearchDelay > 0) {
    await sleep(postSearchDelay);
  }

  await selectKendoPagerSizeWithPreferredFallback(reportContext, ['1000', '300', '100'], {
    visibleClick: true,
    timeout: 45000
  });
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });
}

export async function downloadHyundaiReceiptReport(page, { dealerCode = 'active', account = null } = {}) {
  logger.info('Hyundai Receipt Report started', { dealerCode });
  await openHmilReceiptReport(page);
  const reportContext = await resolveHyundaiReceiptReportContext(page);

  const today = new Date();
  const chunks = getHyundaiReceiptReportChunks(today);
  const runDate = toIsoDate(today);
  const reportChunksDir = account?.reportChunksDir || config.reportChunksDir;
  const chunkDir = path.join(reportChunksDir, 'hyundai-receipt-report', dealerCode, runDate);

  const exportFiles = [];

  logger.info('Hyundai Receipt Report 30-day date chunks prepared', {
    startDate: chunks[0]?.startIso,
    endDate: chunks[chunks.length - 1]?.endIso,
    chunkCount: chunks.length,
    chunkDir
  });

  for (const [index, chunk] of chunks.entries()) {
    const baseName = chunkFileName(chunk);
    const existingChunkFiles = (await fs.readdir(chunkDir).catch(() => []))
      .filter(file => file.startsWith(baseName) && file.endsWith('.xlsx'))
      .map(file => path.join(chunkDir, file));

    if (existingChunkFiles.length > 0) {
      logger.info('Skipping already downloaded Hyundai Receipt Report chunk', {
        chunk: `${index + 1}/${chunks.length}`,
        startDate: chunk.startPortal,
        endDate: chunk.endPortal,
        fileCount: existingChunkFiles.length
      });
      exportFiles.push(...existingChunkFiles);
      continue;
    }

    logger.info('Processing Hyundai Receipt Report chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    await applyHyundaiReceiptReportChunk(reportContext, chunk);

    const chunkFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: chunkDir,
      filenameBase: baseName,
      pageSize: 1000,
      downloadTimeoutMs: 120000
    });


    if (chunkFiles?.length) {
      exportFiles.push(...chunkFiles);
    }

    const betweenDelay = config.hyundaiReceiptReportBetweenChunksDelayMs || 4000;
    if (index < chunks.length - 1 && betweenDelay > 0) {
      await sleep(betweenDelay);
    }
  }

  if (!exportFiles.length) {
    logger.warn('Hyundai Receipt Report yielded no exported grid files across all chunks');
    return {
      name: 'Hyundai Receipt Report',
      id: 'hyundai-receipt-report',
      sheetName: 'hyundai_receipt_report',
      dealerCode,
      rowCount: 0
    };
  }

  const merged = await mergeExcelFiles(exportFiles);
  const enrichedDataset = addSourceDealerCodeToDataset(merged, dealerCode);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'hyundai',
    sheetName: 'hyundai_receipt_report',
    headers: enrichedDataset.headers,
    rows: enrichedDataset.rows
  });

  await cleanupReportExportDir(chunkDir);

  return {
    name: 'Hyundai Receipt Report',
    id: 'hyundai-receipt-report',
    sheetName: 'hyundai_receipt_report',
    dealerCode,
    rowCount: enrichedDataset.rows.length,
    dbResult
  };
}
