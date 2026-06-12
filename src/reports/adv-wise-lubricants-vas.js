import path from 'node:path';
import { config } from '../config.js';
import { openAdvWiseLubricantsVasReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { formatDateForPortal, getCurrentMonthToDateRange, getReportDateOverrideRange, getThirtyDayChunks, parseIsoLocalDate, toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { cleanupReportExportDir, exportAllGridPagesToFiles, mergeExcelFiles } from './paged-export.js';
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByInputId
} from './report-actions.js';

async function resolveAdvWiseLubricantsVasContext(page) {
  const context = await findContextWithVisibleSelector(page, '#startDate', {
    timeout: 90000,
    label: 'Operation Wise Analysis Report Start Date'
  });

  await context.locator('#endDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#dateType').first().waitFor({ state: 'attached', timeout: 30000 });
  logger.info('Operation Wise Analysis Report page loaded');
  return context;
}

async function ensureBillingDateType(page) {
  logger.info('Ensuring Operation Wise Analysis Report date type', {
    dateType: 'Billing Date'
  });

  try {
    await selectKendoDropdownByInputId(page, 'dateType', 'Billing Date');
    return;
  } catch (error) {
    logger.warn('Kendo dateType dropdown selection failed; applying direct fallback', error);
  }

  const input = page.locator('#dateType').first();
  await input.waitFor({ state: 'attached', timeout: 30000 });

  if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
    await input.fill('');
    await input.fill('Billing Date');
    await input.press('Tab').catch(() => {});
    return;
  }

  await input.evaluate(element => {
    element.value = 'Billing Date';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function fillAdvWiseLubricantsVasDateRange(page, range) {
  logger.info('Applying Adv. wise lubricants & VAS date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(page, '#endDate', range.endPortal);
  await fillDate(page, '#startDate', range.startPortal);
}

export async function downloadAdvWiseLubricantsVasReportOptimized(page, { dealerCode, account, startIso, endIso }) {
  logger.info('Adv. wise lubricants & VAS optimized backfill started', {
    dealerCode,
    startIso,
    endIso,
    mode: 'full-range-no-search'
  });
  await openAdvWiseLubricantsVasReport(page);
  const reportContext = await resolveAdvWiseLubricantsVasContext(page);

  await ensureBillingDateType(reportContext);

  const startDate = parseIsoLocalDate(startIso);
  const endDate = parseIsoLocalDate(endIso);
  const range = {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso,
    endIso
  };

  logger.info('Adv. wise lubricants & VAS applying full date range (optimized)', {
    startDate: range.startPortal,
    endDate: range.endPortal,
    mode: 'skip-search-direct-page-size'
  });

  await fillAdvWiseLubricantsVasDateRange(reportContext, range);

  // OPTIMIZATION: Skip search button click - just select page size
  // This causes grid to auto-load all data for the entire date range
  logger.info('Adv. wise lubricants & VAS selecting page size without search click', {
    pageSize: '1000',
    mode: 'full-range-auto-load'
  });
  
  await selectKendoPagerSize(reportContext, '1000');
  await waitForKendoGridIdle(reportContext, { timeout: 300000 }); // Wait up to 5 min for 200k+ rows

  const exportDir = path.join(config.reportChunksDir, 'am-platinum', 'adv-wise-lubricants-vas', dealerCode, `${startIso}_to_${endIso}`);
  
  logger.info('Exporting Adv. wise lubricants & VAS all pages', {
    expectedRowCount: '200000+',
    pageSize: 1000
  });
  
  const pageFiles = await exportAllGridPagesToFiles(reportContext, {
    outputDir: exportDir,
    filenameBase: `adv_wise_lubricants_vas_${dealerCode}_${startIso}_to_${endIso}`,
    pageSize: 1000,
    downloadTimeoutMs: 60000
  });

  logger.info('Adv. wise lubricants & VAS merging exported pages', {
    pageCount: pageFiles.length
  });
  
  const merged = pageFiles.length
    ? await mergeExcelFiles(pageFiles)
    : { headers: [], rows: [] };
  
  const withDealer = merged.rows.length
    ? { ...merged, rows: merged.rows.map(row => ({ ...row, source_dealer_code: dealerCode })) }
    : merged;

  if (!withDealer.rows.length) {
    logger.info('Adv. wise lubricants & VAS had no rows; skipping Supabase save', {
      dealerCode
    });
    await cleanupReportExportDir(exportDir);
    return {
      sheetName: 'AM Platinum Adv. wise lubricants & VAS',
      dbResult: { action: 'no_rows', rowCount: 0 },
      pageCount: pageFiles.length
    };
  }

  const dbResult = await saveReportSheetToSupabase({
    brand: 'am_platinum',
    sheetName: 'AM Platinum Adv. wise lubricants & VAS',
    headers: withDealer.headers,
    rows: withDealer.rows
  });

  await cleanupReportExportDir(exportDir);

  logger.info('Adv. wise lubricants & VAS optimized backfill finished', {
    dealerCode,
    dbAction: dbResult.action,
    rowCount: withDealer.rows.length,
    pageCount: pageFiles.length,
    durationMs: Date.now()
  });

  return {
    sheetName: 'AM Platinum Adv. wise lubricants & VAS',
    dbResult: { ...dbResult, rowCount: withDealer.rows.length },
    pageCount: pageFiles.length
  };
}

export async function downloadAdvWiseLubricantsVasReport(page) {
  logger.info('Adv. wise lubricants & VAS started');
  await openAdvWiseLubricantsVasReport(page);
  const reportContext = await resolveAdvWiseLubricantsVasContext(page);

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
  const exportDir = path.join(config.reportChunksDir, 'adv-wise-lubricants-vas', toIsoDate(new Date()));
  const exportFiles = [];

  await ensureBillingDateType(reportContext);

  logger.info('Adv. wise lubricants & VAS date chunks prepared', {
    mode: config.historicalBackfillEnabled ? 'historical-backfill' : 'current-month',
    startDate: range.startIso,
    endDate: range.endIso,
    chunkCount: chunks.length,
    exportDir
  });

  for (const [index, chunk] of chunks.entries()) {
    await fillAdvWiseLubricantsVasDateRange(reportContext, chunk);

    logger.info('Searching Adv. wise lubricants & VAS chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });
    await clickSearch(reportContext);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    if (config.advWiseLubricantsVasPostSearchDelayMs > 0) {
      logger.info('Waiting briefly after Adv. wise lubricants & VAS search before changing page size', {
        delayMs: config.advWiseLubricantsVasPostSearchDelayMs
      });
      await sleep(config.advWiseLubricantsVasPostSearchDelayMs);
    }

    await selectKendoPagerSize(reportContext, config.advWiseLubricantsVasPageSize);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    logger.info('Exporting Adv. wise lubricants & VAS chunk pages');
    const chunkFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: exportDir,
      filenameBase: `adv_wise_lubricants_vas_${chunk.startIso}_to_${chunk.endIso}`,
      pageSize: config.advWiseLubricantsVasPageSize
    });
    exportFiles.push(...chunkFiles);
  }

  const merged = await mergeExcelFiles(exportFiles);
  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.advWiseLubricantsVasSheetName,
    headers: merged.headers,
    rows: merged.rows
  });
  await cleanupReportExportDir(exportDir);

  logger.info('Adv. wise lubricants & VAS finished', {
    sheetName: config.advWiseLubricantsVasSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    pageCount: exportFiles.length,
    addedRowCount: dbResult.addedRowCount,
    duplicateRowCount: dbResult.duplicateRowCount
  });

  return {
    name: 'Adv. wise lubricants & VAS',
    sheetName: config.advWiseLubricantsVasSheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length,
      pageCount: exportFiles.length
    },
    dateRange: range
  };
}
