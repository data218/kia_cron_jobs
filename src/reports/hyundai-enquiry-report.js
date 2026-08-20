import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

import { openHmilEnquiryReport } from '../navigation/hmil-menu.js';
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
import { exportAllGridPagesToFiles, mergeExcelFiles } from './paged-export.js';
import { addSourceDealerCodeToDataset } from './report-metadata.js';
import {
  clickSearch,
  fillDate,
  getInputValue,
  listKendoDropdownOptions,
  selectKendoDropdownOptionContaining
} from './report-actions.js';

function FiveYearsAgoDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 5);
  return date;
}

function chunkFileName(chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `hyundai_enquiry_report_${start}_to_${end}`;
}

export function getHyundaiEnquiryReportChunks(today = new Date()) {
  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return getThirtyDayChunks(overrideRange.startDate, overrideRange.endDate);
  }

  const startDateStr = config.hyundaiEnquiryReportBackfillStartDate || config.historicalBackfillStartDate;
  const startDate = startDateStr ? parseIsoLocalDate(startDateStr) : FiveYearsAgoDate();

  return getThirtyDayChunks(startDate, today);
}

async function resolveHyundaiEnquiryReportContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sDateFromDate', {
    timeout: 90000,
    label: 'Hyundai Enquiry Report Date From'
  });

  await context.locator('#sDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Hyundai Enquiry Report page loaded');
  return context;
}

/**
 * Returns the Main Dealer codes this login actually exposes on the Enquiry Report,
 * parsed out of option labels like `[N5216] JAMMU AUTO MART PRIVATE LIMITED`.
 *
 * Worth calling before a backfill: the MIS5216 login exposes exactly one Main Dealer
 * (N5216) whose export is group-wide — the per-outlet code lands in the report's own
 * `dealer_code_2` column — so iterating a hardcoded N6844..N6848 list would just re-export
 * identical data five extra times.
 */
export async function listHyundaiEnquiryMainDealers(page) {
  await openHmilEnquiryReport(page);
  const reportContext = await resolveHyundaiEnquiryReportContext(page);

  const options = await listKendoDropdownOptions(reportContext, 'sMainDealer');
  const dealers = options
    .map(label => {
      const match = label.match(/\[([A-Za-z0-9]+)\]/);
      return match ? { code: match[1].toUpperCase(), label } : null;
    })
    .filter(Boolean);

  logger.info('Hyundai Enquiry Report Main Dealer options discovered', {
    optionCount: options.length,
    dealers: dealers.map(dealer => dealer.code),
    rawOptions: options
  });

  return dealers;
}

async function selectMainDealer(reportContext, dealerCode) {
  const targetCode = String(dealerCode || '').trim().toUpperCase();
  if (!targetCode) {
    throw new Error('Hyundai Enquiry Report requires a dealer code to select the Main Dealer dropdown');
  }

  const mainDealerInput = reportContext.locator('#sMainDealer').first();
  if (!(await mainDealerInput.count().catch(() => 0))) {
    logger.warn('Main Dealer dropdown not present on the Enquiry Report view; continuing with portal default');
    return null;
  }

  let selected = await selectKendoDropdownOptionContaining(reportContext, 'sMainDealer', targetCode);

  // Sub-dealers (N6844..N6848) sit under main dealer N5216, so when the loop is on a
  // sub-dealer the dropdown offers only the parent. Selecting the sole option is correct
  // there — the portal scopes the result by the ACTIVE dealer, which the caller has
  // already switched. Selecting nothing at all is not: a blank Main Dealer silently
  // returns another dealer's rows.
  if (!selected) {
    selected = await selectKendoDropdownOptionContaining(reportContext, 'sMainDealer', '');
    if (selected) {
      logger.warn('Main Dealer dropdown does not list this dealer; selected its parent instead', {
        requestedDealerCode: targetCode,
        selected
      });
    }
  }

  if (!selected) {
    throw new Error(
      `Could not select any Main Dealer for ${targetCode} in the sMainDealer dropdown. ` +
      `Refusing to search, because a blank Main Dealer silently returns another dealer's rows.`
    );
  }

  logger.info('Main Dealer selected for Hyundai Enquiry Report', { dealerCode: targetCode, selected });
  return selected;
}

async function applyHyundaiEnquiryReportChunk(reportContext, chunk, { dealerCode } = {}) {
  logger.info('Applying Hyundai Enquiry Report date range', {
    dealerCode,
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  await selectMainDealer(reportContext, dealerCode);

  await fillDate(reportContext, '#sDateToDate', chunk.endPortal);
  await fillDate(reportContext, '#sDateFromDate', chunk.startPortal);

  const actualStart = await getInputValue(reportContext, '#sDateFromDate');
  const actualEnd = await getInputValue(reportContext, '#sDateToDate');
  logger.info('Hyundai Enquiry Report date fields verified before search', {
    expectedStart: chunk.startPortal,
    actualStart,
    expectedEnd: chunk.endPortal,
    actualEnd
  });

  if (actualStart.trim() !== chunk.startPortal || actualEnd.trim() !== chunk.endPortal) {
    throw new Error(
      `Hyundai Enquiry Report date fields did not retain expected values. ` +
      `Expected ${chunk.startPortal} - ${chunk.endPortal}, got ${actualStart} - ${actualEnd}`
    );
  }

  logger.info('Searching Hyundai Enquiry Report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  const postSearchDelay = config.hyundaiEnquiryReportPostSearchDelayMs || 5000;
  if (postSearchDelay > 0) {
    await sleep(postSearchDelay);
  }

  await selectKendoPagerSizeWithPreferredFallback(reportContext, ['1000', '300', '100'], {
    visibleClick: true,
    timeout: 45000
  });
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });
}

// Written once a chunk's rows are safely in Postgres, so an interrupted multi-day backfill
// resumes at the first chunk that was never uploaded instead of starting over.
function chunkMarkerPath(chunkDir, baseName) {
  return path.join(chunkDir, `${baseName}.saved.json`);
}

async function chunkAlreadySaved(chunkDir, baseName) {
  return fs.readFile(chunkMarkerPath(chunkDir, baseName), 'utf8')
    .then(() => true)
    .catch(() => false);
}

/**
 * Counts how the export's OWN dealer column is distributed.
 *
 * The Enquiry Report carries both a main-dealer and a per-row outlet column; the outlet one
 * is the last dealer-ish header and lands in Postgres as `dealer_code_2`. Comparing it to
 * the dealer we asked for is the only way to tell whether the portal actually scoped the
 * export to the active dealer or handed back the whole group.
 */
function summariseExportDealers(headers, rows) {
  const dealerIndexes = headers
    .map((header, index) => ({ header: String(header ?? ''), index }))
    .filter(entry => /dealer/i.test(entry.header) && !/name/i.test(entry.header));

  if (!dealerIndexes.length) return null;

  const { index, header } = dealerIndexes[dealerIndexes.length - 1];
  const counts = new Map();
  for (const row of rows) {
    const value = String(row?.[index] ?? '').trim().toUpperCase();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return { column: header, counts: Object.fromEntries(counts) };
}

function assertExportScopedToDealer(headers, rows, dealerCode) {
  const summary = summariseExportDealers(headers, rows);
  if (!summary || !Object.keys(summary.counts).length) return;

  const target = String(dealerCode).trim().toUpperCase();
  const total = Object.values(summary.counts).reduce((sum, n) => sum + n, 0);
  const mine = summary.counts[target] ?? 0;

  if (mine / total >= 0.5) return;

  const error = new Error(
    `Export for dealer ${target} is NOT scoped to that dealer: only ${mine}/${total} rows ` +
    `carry it in "${summary.column}" (${JSON.stringify(summary.counts)}). ` +
    `This portal returns the whole dealer group from one export, so running per-dealer would ` +
    `write a mislabelled copy of the same rows for every dealer — they differ only by ` +
    `source_dealer_code, so row_hash will NOT dedupe them. ` +
    `Run the single main dealer instead, or pass --allow-unscoped to override.`
  );
  error.code = 'EXPORT_NOT_SCOPED';
  throw error;
}

async function saveChunkRows(chunkFiles, { dealerCode, chunk, chunkDir, baseName, enforceScope = true }) {
  if (!chunkFiles.length) {
    await fs.writeFile(
      chunkMarkerPath(chunkDir, baseName),
      JSON.stringify({ dealerCode, range: `${chunk.startIso}..${chunk.endIso}`, rowCount: 0 }, null, 2)
    );
    return 0;
  }

  const merged = await mergeExcelFiles(chunkFiles);

  if (enforceScope && merged.rows.length) {
    assertExportScopedToDealer(merged.headers, merged.rows, dealerCode);
  }

  const enrichedDataset = addSourceDealerCodeToDataset(merged, dealerCode);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'hyundai',
    sheetName: 'hyundai_enquiry_report',
    headers: enrichedDataset.headers,
    rows: enrichedDataset.rows
  });

  await fs.writeFile(
    chunkMarkerPath(chunkDir, baseName),
    JSON.stringify({
      dealerCode,
      range: `${chunk.startIso}..${chunk.endIso}`,
      rowCount: enrichedDataset.rows.length,
      dbResult
    }, null, 2)
  );

  logger.info('Hyundai Enquiry Report chunk saved to Supabase', {
    dealerCode,
    range: `${chunk.startIso}..${chunk.endIso}`,
    rowCount: enrichedDataset.rows.length,
    addedRowCount: dbResult?.addedRowCount,
    duplicateRowCount: dbResult?.duplicateRowCount
  });

  // Chunk files are no longer needed once the rows are in Postgres; a 20-year backfill
  // would otherwise leave tens of GB of xlsx behind.
  await Promise.all(chunkFiles.map(file => fs.rm(file, { force: true }).catch(() => {})));

  return enrichedDataset.rows.length;
}

export async function downloadHyundaiEnquiryReport(page, {
  dealerCode = 'N5216',
  account = null,
  startDate = null,
  endDate = null,
  enforceScope = true
} = {}) {
  logger.info('Hyundai Enquiry Report started', { dealerCode, startDate, endDate });
  await openHmilEnquiryReport(page);
  let reportContext = await resolveHyundaiEnquiryReportContext(page);

  // The portal tears down and recreates tabMenuFrameN as the grid is worked, so a frame
  // captured for chunk 1 is routinely detached by chunk 2. Re-validate before each chunk.
  const ensureReportContext = async () => {
    const alive = await reportContext.locator('#sDateFromDate').first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (alive) return reportContext;

    logger.warn('Enquiry Report frame is detached; re-opening the report');
    await openHmilEnquiryReport(page);
    reportContext = await resolveHyundaiEnquiryReportContext(page);
    return reportContext;
  };

  const today = new Date();
  let chunks;
  // Keyed by START date only. Including the end date made the folder name change every
  // day whenever end defaulted to "today", so yesterday's resume markers became invisible
  // and the whole range re-downloaded from scratch.
  let subDirName = `from-${toIsoDate(today)}`;

  if (startDate && endDate) {
    chunks = getThirtyDayChunks(parseIsoLocalDate(startDate), parseIsoLocalDate(endDate));
    // Keyed by the requested range rather than by today's date so a backfill that runs
    // past midnight still finds — and skips — the chunks it already completed.
    subDirName = `from-${startDate}`;
  } else {
    chunks = getHyundaiEnquiryReportChunks(today);
  }

  const reportChunksDir = account?.reportChunksDir || config.reportChunksDir;
  const chunkDir = path.join(reportChunksDir, 'hyundai-enquiry-report', dealerCode, subDirName);
  await fs.mkdir(chunkDir, { recursive: true });

  logger.info('Hyundai Enquiry Report 30-day date chunks prepared', {
    dealerCode,
    startDate: chunks[0]?.startIso,
    endDate: chunks[chunks.length - 1]?.endIso,
    chunkCount: chunks.length,
    chunkDir
  });

  let totalRowCount = 0;
  let savedChunkCount = 0;
  let skippedChunkCount = 0;
  const failedChunks = [];

  for (const [index, chunk] of chunks.entries()) {
    const baseName = chunkFileName(chunk);
    const label = `${index + 1}/${chunks.length}`;

    if (await chunkAlreadySaved(chunkDir, baseName)) {
      skippedChunkCount += 1;
      logger.info('Skipping Hyundai Enquiry Report chunk already saved to Supabase', {
        dealerCode,
        chunk: label,
        startDate: chunk.startPortal,
        endDate: chunk.endPortal
      });
      continue;
    }

    logger.info('Processing Hyundai Enquiry Report chunk', {
      dealerCode,
      chunk: label,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });

    try {
      const context = await ensureReportContext();
      await applyHyundaiEnquiryReportChunk(context, chunk, { dealerCode });

      const chunkFiles = await exportAllGridPagesToFiles(context, {
        outputDir: chunkDir,
        filenameBase: baseName,
        pageSize: 1000,
        downloadTimeoutMs: 300000
      });

      totalRowCount += await saveChunkRows(chunkFiles ?? [], {
        dealerCode,
        chunk,
        chunkDir,
        baseName,
        enforceScope
      });
      savedChunkCount += 1;
    } catch (chunkError) {
      // A scope violation is not a transient chunk failure — every later chunk would
      // repeat it and write mislabelled rows. Abort the dealer immediately.
      if (chunkError.code === 'EXPORT_NOT_SCOPED') throw chunkError;

      // One bad 30-day window must not abandon the remaining 20 years.
      failedChunks.push(`${chunk.startIso}..${chunk.endIso}`);
      logger.error('Hyundai Enquiry Report chunk failed; continuing with the next chunk', {
        dealerCode,
        chunk: label,
        startDate: chunk.startPortal,
        endDate: chunk.endPortal,
        error: chunkError.message
      });

      // Re-open the report so a broken frame/grid does not cascade into every later chunk.
      await openHmilEnquiryReport(page).catch(() => {});
      reportContext = await resolveHyundaiEnquiryReportContext(page).catch(() => reportContext);
    }

    const betweenDelay = config.hyundaiEnquiryReportBetweenChunksDelayMs || 4000;
    if (index < chunks.length - 1 && betweenDelay > 0) {
      await sleep(betweenDelay);
    }
  }

  logger.info('Hyundai Enquiry Report finished for dealer', {
    dealerCode,
    totalRowCount,
    savedChunkCount,
    skippedChunkCount,
    failedChunkCount: failedChunks.length
  });

  return {
    name: 'Hyundai Enquiry Report',
    id: 'hyundai-enquiry-report',
    sheetName: 'hyundai_enquiry_report',
    dealerCode,
    rowCount: totalRowCount,
    savedChunkCount,
    skippedChunkCount,
    failedChunks
  };
}
