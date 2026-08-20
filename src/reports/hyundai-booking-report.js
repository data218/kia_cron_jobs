import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

import { openHmilBookingReport } from '../navigation/hmil-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import {

  getCalendarMonthRanges,
  parseIsoLocalDate,
  toIsoDate
} from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSizeWithPreferredFallback, waitForKendoGridIdle } from './grid.js';
import { exportAllGridPagesToFiles, mergeExcelFiles } from './paged-export.js';
import { addSourceDealerCodeToDataset } from './report-metadata.js';
import { clickSearch, fillDate, getInputValue } from './report-actions.js';

// The Booking Report uses #sFromDate/#sToDate — NOT the #sDateFromDate/#sDateToDate pair
// the Enquiry and Sales reports use. Both are data-role="extmaskeddatepicker".
const FROM_SELECTOR = '#sFromDate';
const TO_SELECTOR = '#sToDate';

function chunkFileName(range) {
  return `hyundai_booking_report_${range.startIso.replaceAll('-', '_')}_to_${range.endIso.replaceAll('-', '_')}`;
}

// First day of the month 11 months back, giving 12 whole calendar months including the
// current one. Snapping to the 1st keeps month boundaries — and therefore resume marker
// filenames — identical from one day to the next; "today minus 365 days" shifted them daily.
function defaultWindowStart(today = new Date()) {
  return new Date(today.getFullYear(), today.getMonth() - 11, 1);
}

/**
 * Month-wise ranges covering the last year by default — the portal's Booking Report is
 * queried a calendar month at a time rather than in rolling 30-day chunks.
 */
export function getHyundaiBookingReportRanges(today = new Date(), { startDate, endDate } = {}) {
  const start = startDate ? parseIsoLocalDate(startDate) : defaultWindowStart(today);
  const end = endDate ? parseIsoLocalDate(endDate) : today;
  return getCalendarMonthRanges(start, end);
}

async function resolveBookingReportContext(page) {
  const context = await findContextWithVisibleSelector(page, FROM_SELECTOR, {
    timeout: 90000,
    label: 'Hyundai Booking Report Date From'
  });

  await context.locator(TO_SELECTOR).first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Hyundai Booking Report page loaded');
  return context;
}

async function applyBookingReportRange(reportContext, range) {
  const { startPortal, endPortal } = range;

  logger.info('Applying Hyundai Booking Report date range', { startDate: startPortal, endDate: endPortal });

  await fillDate(reportContext, TO_SELECTOR, endPortal);
  await fillDate(reportContext, FROM_SELECTOR, startPortal);

  const actualStart = await getInputValue(reportContext, FROM_SELECTOR);
  const actualEnd = await getInputValue(reportContext, TO_SELECTOR);
  logger.info('Hyundai Booking Report date fields verified before search', {
    expectedStart: startPortal,
    actualStart,
    expectedEnd: endPortal,
    actualEnd
  });

  if (actualStart.trim() !== startPortal || actualEnd.trim() !== endPortal) {
    throw new Error(
      `Hyundai Booking Report date fields did not retain expected values. ` +
      `Expected ${startPortal} - ${endPortal}, got ${actualStart} - ${actualEnd}`
    );
  }

  logger.info('Searching Hyundai Booking Report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  const postSearchDelay = config.hyundaiBookingReportPostSearchDelayMs || 5000;
  if (postSearchDelay > 0) await sleep(postSearchDelay);

  await selectKendoPagerSizeWithPreferredFallback(reportContext, ['300', '100'], {
    visibleClick: true,
    timeout: 45000
  });
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });
}

export async function downloadHyundaiBookingReport(page, {
  dealerCode = 'active',
  account = null,
  startDate = null,
  endDate = null
} = {}) {
  logger.info('Hyundai Booking Report started', { dealerCode, startDate, endDate });
  await openHmilBookingReport(page);
  let reportContext = await resolveBookingReportContext(page);

  const today = new Date();
  const ranges = getHyundaiBookingReportRanges(today, { startDate, endDate });
  // Keyed by the effective START only. Including the end date (or today's date) made the
  // folder name change daily, hiding yesterday's markers and re-downloading everything.
  const subDirName = `from-${ranges[0]?.startIso ?? toIsoDate(today)}`;

  // Resolved through the account so the AM Platinum profile lands in
  // am_platinum_booking_report while HMIL lands in hyundai_booking_report.
  const sheetName = account?.sheetName
    ? account.sheetName('Hyundai Booking Report')
    : 'Hyundai Booking Report';

  const reportChunksDir = account?.reportChunksDir || config.reportChunksDir;
  const chunkDir = path.join(reportChunksDir, 'hyundai-booking-report', dealerCode, subDirName);
  await fs.mkdir(chunkDir, { recursive: true });

  logger.info('Hyundai Booking Report month ranges prepared', {
    dealerCode,
    sheetName,
    startDate: ranges[0]?.startIso,
    endDate: ranges[ranges.length - 1]?.endIso,
    rangeCount: ranges.length,
    chunkDir
  });

  const markerPath = baseName => path.join(chunkDir, `${baseName}.saved.json`);
  const alreadySaved = baseName => fs.readFile(markerPath(baseName), 'utf8')
    .then(() => true)
    .catch(() => false);

  let totalRowCount = 0;
  let savedChunkCount = 0;
  let skippedChunkCount = 0;
  const failedRanges = [];

  for (const [index, range] of ranges.entries()) {
    const baseName = chunkFileName(range);
    const label = `${index + 1}/${ranges.length}`;

    if (await alreadySaved(baseName)) {
      skippedChunkCount += 1;
      logger.info('Skipping Hyundai Booking Report month already saved', {
        dealerCode,
        month: label,
        range: `${range.startIso}..${range.endIso}`
      });
      continue;
    }

    logger.info('Processing Hyundai Booking Report month', {
      dealerCode,
      month: label,
      range: `${range.startIso}..${range.endIso}`
    });

    try {
      await applyBookingReportRange(reportContext, range);

      const chunkFiles = await exportAllGridPagesToFiles(reportContext, {
        outputDir: chunkDir,
        filenameBase: baseName,
        pageSize: 300,
        downloadTimeoutMs: 300000
      }) ?? [];

      let rowCount = 0;
      if (chunkFiles.length) {
        const merged = await mergeExcelFiles(chunkFiles);
        const enrichedDataset = addSourceDealerCodeToDataset(merged, dealerCode);

        const dbResult = await saveReportSheetToSupabase({
          brand: account?.brand ?? 'hyundai',
          sheetName,
          headers: enrichedDataset.headers,
          rows: enrichedDataset.rows
        });

        rowCount = enrichedDataset.rows.length;
        logger.info('Hyundai Booking Report month saved to Supabase', {
          dealerCode,
          sheetName,
          range: `${range.startIso}..${range.endIso}`,
          rowCount,
          addedRowCount: dbResult?.addedRowCount
        });

        await Promise.all(chunkFiles.map(file => fs.rm(file, { force: true }).catch(() => {})));
      }

      await fs.writeFile(markerPath(baseName), JSON.stringify({
        dealerCode,
        sheetName,
        range: `${range.startIso}..${range.endIso}`,
        rowCount
      }, null, 2));

      totalRowCount += rowCount;
      savedChunkCount += 1;
    } catch (rangeError) {
      failedRanges.push(`${range.startIso}..${range.endIso}`);
      logger.error('Hyundai Booking Report month failed; continuing with the next month', {
        dealerCode,
        month: label,
        error: rangeError.message
      });

      // Re-open so a detached frame does not cascade into every later month.
      await openHmilBookingReport(page).catch(() => {});
      reportContext = await resolveBookingReportContext(page).catch(() => reportContext);
    }

    const betweenDelay = config.hyundaiBookingReportBetweenChunksDelayMs || 4000;
    if (index < ranges.length - 1 && betweenDelay > 0) await sleep(betweenDelay);
  }

  logger.info('Hyundai Booking Report finished for dealer', {
    dealerCode,
    sheetName,
    totalRowCount,
    savedChunkCount,
    skippedChunkCount,
    failedRangeCount: failedRanges.length
  });

  return {
    name: 'Hyundai Booking Report',
    id: 'hyundai-booking-report',
    sheetName,
    dealerCode,
    rowCount: totalRowCount,
    savedChunkCount,
    skippedChunkCount,
    failedRanges
  };
}
