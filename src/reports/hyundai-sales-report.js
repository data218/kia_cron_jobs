import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

import { openHmilSalesReport } from '../navigation/hmil-menu.js';
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
  return `hyundai_sales_report_${start}_to_${end}`;
}

export function getHyundaiSalesReportChunks(today = new Date()) {
  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return getThirtyDayChunks(overrideRange.startDate, overrideRange.endDate);
  }

  const startDateStr = config.hyundaiSalesReportBackfillStartDate || config.historicalBackfillStartDate;
  const startDate = startDateStr ? parseIsoLocalDate(startDateStr) : FiveYearsAgoDate();

  return getThirtyDayChunks(startDate, today);
}

async function selectConfirmDateRadio(context) {
  const radio = context.locator([
    '#confirmDate',
    '#confirmdate',
    'input[type="radio"][value="confirmDate"]',
    'input[type="radio"][name="radio"][value="confirmDate"]',
    'label:has-text("Confirm Date") input[type="radio"]',
    'label:has-text("Confirm date") input[type="radio"]'
  ].join(',')).first();

  await radio.waitFor({ state: 'visible', timeout: 30000 });
  await radio.check({ force: true }).catch(async () => {
    await radio.click({ force: true });
  });
  logger.info('Hyundai Sales Report confirmDate radio selected');
}

async function resolveHyundaiSalesReportContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sDateFromDate', {
    timeout: 90000,
    label: 'Hyundai Sales Report Date From'
  });

  await context.locator('#sDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Hyundai Sales Report page loaded');
  return context;
}

async function applyHyundaiSalesReportChunk(reportContext, chunk) {
  logger.info('Applying Hyundai Sales Report date range', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  await selectConfirmDateRadio(reportContext);

  await fillDate(reportContext, '#sDateToDate', chunk.endPortal);
  await fillDate(reportContext, '#sDateFromDate', chunk.startPortal);

  const actualStart = await getInputValue(reportContext, '#sDateFromDate');
  const actualEnd = await getInputValue(reportContext, '#sDateToDate');
  logger.info('Hyundai Sales Report date fields verified before search', {
    expectedStart: chunk.startPortal,
    actualStart,
    expectedEnd: chunk.endPortal,
    actualEnd
  });

  if (actualStart.trim() !== chunk.startPortal || actualEnd.trim() !== chunk.endPortal) {
    throw new Error(
      `Hyundai Sales Report date fields did not retain expected values. ` +
      `Expected ${chunk.startPortal} - ${chunk.endPortal}, got ${actualStart} - ${actualEnd}`
    );
  }

  logger.info('Searching Hyundai Sales Report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  const postSearchDelay = config.hyundaiSalesReportPostSearchDelayMs || 5000;
  if (postSearchDelay > 0) {
    await sleep(postSearchDelay);
  }

  await selectKendoPagerSizeWithPreferredFallback(reportContext, ['1000', '300'], {
    visibleClick: true,
    timeout: 45000
  });
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });
}

/**
 * Drops the grid's footer/summary row from an exported dataset.
 *
 * The portal's Sales Report grid ends each page with a totals line that carries the literal
 * "TOTAL" in the registration-name column and NULLs everywhere else. Exported verbatim it
 * became a real row in Postgres — 309 of them in hyundai_sales_report, 20 in
 * am_platinum_sales_report — silently inflating counts and any SUM over the table.
 */
function dropGridTotalRows(dataset) {
  const nameIndex = dataset.headers.findIndex(
    header => /registration/i.test(String(header ?? '')) && /name/i.test(String(header ?? ''))
  );
  if (nameIndex < 0) return dataset;

  const rows = dataset.rows.filter(
    row => String(row?.[nameIndex] ?? '').trim().toUpperCase() !== 'TOTAL'
  );

  const dropped = dataset.rows.length - rows.length;
  if (dropped > 0) {
    logger.info('Dropped grid TOTAL footer rows before save', { dropped, column: dataset.headers[nameIndex] });
  }

  return { ...dataset, rows };
}

export async function downloadHyundaiSalesReport(page, {
  dealerCode = 'active',
  account = null,
  startDate = null,
  endDate = null
} = {}) {
  logger.info('Hyundai Sales Report started', { dealerCode, startDate, endDate });
  await openHmilSalesReport(page);
  let reportContext = await resolveHyundaiSalesReportContext(page);

  const today = new Date();
  let chunks;
  // Keyed by START date only. Including the end date made the folder name change every
  // day whenever end defaulted to "today", so yesterday's resume markers became invisible
  // and the whole range re-downloaded from scratch.
  let subDirName = `from-${toIsoDate(today)}`;

  if (startDate && endDate) {
    const sDate = parseIsoLocalDate(startDate);
    const eDate = parseIsoLocalDate(endDate);
    chunks = getThirtyDayChunks(sDate, eDate);
    subDirName = `from-${startDate}`;
  } else {
    chunks = getHyundaiSalesReportChunks(today);
  }

  // Resolved through the account so AM Platinum lands in am_platinum_sales_report while
  // HMIL keeps writing hyundai_sales_report (its profile applies no prefix).
  const sheetName = account?.sheetName
    ? account.sheetName('Hyundai Sales Report')
    : 'hyundai_sales_report';

  const reportChunksDir = account?.reportChunksDir || config.reportChunksDir;
  const chunkDir = path.join(reportChunksDir, 'hyundai-sales-report', dealerCode, subDirName);

  await fs.mkdir(chunkDir, { recursive: true });

  logger.info('Hyundai Sales Report 30-day date chunks prepared', {
    dealerCode,
    startDate: chunks[0]?.startIso,
    endDate: chunks[chunks.length - 1]?.endIso,
    chunkCount: chunks.length,
    chunkDir
  });

  // Same crash-safety contract as the Enquiry Report: each chunk is uploaded and marked as
  // it completes, so a 15-year backfill that dies at chunk 180 keeps chunks 1-179.
  const markerPath = baseName => path.join(chunkDir, `${baseName}.saved.json`);
  const alreadySaved = baseName => fs.readFile(markerPath(baseName), 'utf8')
    .then(() => true)
    .catch(() => false);

  let totalRowCount = 0;
  let savedChunkCount = 0;
  let skippedChunkCount = 0;
  const failedChunks = [];

  for (const [index, chunk] of chunks.entries()) {
    const baseName = chunkFileName(chunk);
    const label = `${index + 1}/${chunks.length}`;

    if (await alreadySaved(baseName)) {
      skippedChunkCount += 1;
      logger.info('Skipping Hyundai Sales Report chunk already saved to Supabase', {
        dealerCode,
        chunk: label,
        startDate: chunk.startPortal,
        endDate: chunk.endPortal
      });
      continue;
    }

    logger.info('Processing Hyundai Sales Report chunk', {
      dealerCode,
      chunk: label,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    try {
      await applyHyundaiSalesReportChunk(reportContext, chunk);

      const chunkFiles = await exportAllGridPagesToFiles(reportContext, {
        outputDir: chunkDir,
        filenameBase: baseName,
        downloadTimeoutMs: 300000
      }) ?? [];

      let rowCount = 0;
      if (chunkFiles.length) {
        const merged = dropGridTotalRows(await mergeExcelFiles(chunkFiles));
        const enrichedDataset = addSourceDealerCodeToDataset(merged, dealerCode);

        const dbResult = await saveReportSheetToSupabase({
          brand: account?.brand ?? 'hyundai',
          sheetName,
          headers: enrichedDataset.headers,
          rows: enrichedDataset.rows
        });

        rowCount = enrichedDataset.rows.length;
        logger.info('Hyundai Sales Report chunk saved to Supabase', {
          dealerCode,
          range: `${chunk.startIso}..${chunk.endIso}`,
          rowCount,
          addedRowCount: dbResult?.addedRowCount
        });

        await Promise.all(chunkFiles.map(file => fs.rm(file, { force: true }).catch(() => {})));
      }

      await fs.writeFile(markerPath(baseName), JSON.stringify({
        dealerCode,
        range: `${chunk.startIso}..${chunk.endIso}`,
        rowCount
      }, null, 2));

      totalRowCount += rowCount;
      savedChunkCount += 1;
    } catch (chunkError) {
      failedChunks.push(`${chunk.startIso}..${chunk.endIso}`);
      logger.error('Hyundai Sales Report chunk failed; continuing with the next chunk', {
        dealerCode,
        chunk: label,
        error: chunkError.message
      });

      await openHmilSalesReport(page).catch(() => {});
      reportContext = await resolveHyundaiSalesReportContext(page).catch(() => reportContext);
    }

    const betweenDelay = config.hyundaiSalesReportBetweenChunksDelayMs || 4000;
    if (index < chunks.length - 1 && betweenDelay > 0) {
      await sleep(betweenDelay);
    }
  }

  logger.info('Hyundai Sales Report finished for dealer', {
    dealerCode,
    totalRowCount,
    savedChunkCount,
    skippedChunkCount,
    failedChunkCount: failedChunks.length
  });

  return {
    name: 'Hyundai Sales Report',
    id: 'hyundai-sales-report',
    sheetName,
    dealerCode,
    rowCount: totalRowCount,
    savedChunkCount,
    skippedChunkCount,
    failedChunks
  };
}
