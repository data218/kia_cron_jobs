import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { openAdvWiseLubricantsVasReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToRelationalTable } from '../supabase/relational-store.js';
import {
  addDays,
  formatDateForPortal,
  getCurrentMonthToDateRange,
  getReportDateOverrideRange,
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
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByInputId
} from './report-actions.js';

const DEFAULT_REPORT_TYPES = ['Operation', 'Part'];

function getReportTypesToRun() {
  const allowed = new Set(DEFAULT_REPORT_TYPES.map(value => value.toLowerCase()));
  const configuredTypes = Array.isArray(config.operationWiseAnalysisReportTypes)
    ? config.operationWiseAnalysisReportTypes
    : DEFAULT_REPORT_TYPES;
  const reportTypes = configuredTypes
    .map(value => DEFAULT_REPORT_TYPES.find(type => type.toLowerCase() === String(value).trim().toLowerCase()))
    .filter(type => type && allowed.has(type.toLowerCase()));

  return reportTypes.length ? [...new Set(reportTypes)] : DEFAULT_REPORT_TYPES;
}

function sanitizeName(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function buildRunDir() {
  const now = new Date();
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('-');

  return path.join(
    config.reportChunksDir,
    'operation-wise-analysis-report',
    `${toIsoDate(now)}_${time}`
  );
}

function buildChunk(startDate, endDate) {
  const reportMonth = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  return {
    startDate,
    endDate,
    reportMonth,
    reportMonthIso: toIsoDate(reportMonth),
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

function getMonthlyThirtyDayChunks(startDate, endDate) {
  const chunks = [];
  const firstDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const finalDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  let monthStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1);

  while (monthStart <= finalDate) {
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    const cappedStart = monthStart < firstDate ? firstDate : monthStart;
    const cappedEnd = monthEnd > finalDate ? finalDate : monthEnd;
    let chunkStart = cappedStart;

    while (chunkStart <= cappedEnd) {
      const thirtyDayEnd = addDays(chunkStart, 29);
      const chunkEnd = thirtyDayEnd > cappedEnd ? cappedEnd : thirtyDayEnd;
      chunks.push(buildChunk(chunkStart, chunkEnd));
      chunkStart = addDays(chunkEnd, 1);
    }

    monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  }

  return chunks;
}

async function resolveOperationWiseAnalysisContext(page) {
  const context = await findContextWithVisibleSelector(page, '#startDate', {
    timeout: 90000,
    label: 'Operation Wise Analysis Report Start Date'
  });

  await context.locator('#endDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#reportType').first().waitFor({ state: 'attached', timeout: 30000 });
  await context.locator('#dateType').first().waitFor({ state: 'attached', timeout: 30000 });
  logger.info('Operation Wise Analysis Report page loaded');
  return context;
}

async function getKendoDropdownText(page, inputId) {
  const widget = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]`
  ).first();

  return widget.locator('.k-input').first().innerText({ timeout: 5000 })
    .then(text => text.trim())
    .catch(() => '');
}

async function ensureKendoDropdownValue(page, inputId, value) {
  const currentValue = await getKendoDropdownText(page, inputId);
  if (currentValue === value) {
    logger.info('Kendo dropdown already selected', {
      inputId,
      value
    });
    return;
  }

  await selectKendoDropdownByInputId(page, inputId, value);
  await waitForKendoGridIdle(page, { timeout: 120000 });
}

async function ensureBillingDateType(page) {
  logger.info('Ensuring Operation Wise Analysis date type', {
    dateType: 'Billing Date'
  });
  await ensureKendoDropdownValue(page, 'dateType', 'Billing Date');
}

async function ensureReportType(page, reportType) {
  logger.info('Ensuring Operation Wise Analysis report type', { reportType });
  await ensureKendoDropdownValue(page, 'reportType', reportType);
}

async function fillOperationWiseAnalysisDateRange(page, range, reportType) {
  logger.info('Applying Operation Wise Analysis date range', {
    reportType,
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(page, '#endDate', range.endPortal);
  await fillDate(page, '#startDate', range.startPortal);
}

function addReportMetadataToDataset(reportType, range, merged) {
  const metadataHeaders = [
    'report_type',
    'report_month',
    'report_period_start',
    'report_period_end'
  ];
  const headers = [
    ...metadataHeaders,
    ...merged.headers.filter(header => !metadataHeaders.includes(header))
  ];
  const rows = merged.rows.map(row => ({
    report_type: reportType,
    report_month: range.reportMonthIso,
    report_period_start: range.startIso,
    report_period_end: range.endIso,
    ...row
  }));

  return { headers, rows };
}

async function exportChunkToRelationalTable(page, {
  reportType,
  range,
  outputDir
}) {
  logger.info('[Operation Wise Analysis Report] Searching chunk', {
    reportType,
    startDate: range.startIso,
    endDate: range.endIso
  });

  await ensureBillingDateType(page);
  await fillOperationWiseAnalysisDateRange(page, range, reportType);
  await clickSearch(page);
  await waitForKendoGridIdle(page, { timeout: 120000 });

  if (config.operationWiseAnalysisPostSearchDelayMs > 0) {
    logger.info('[Operation Wise Analysis Report] Waiting after search before page-size selection', {
      reportType,
      startDate: range.startIso,
      endDate: range.endIso,
      delayMs: config.operationWiseAnalysisPostSearchDelayMs
    });
    await sleep(config.operationWiseAnalysisPostSearchDelayMs);
  }

  await selectKendoPagerSize(page, config.operationWiseAnalysisPageSize);
  await waitForKendoGridIdle(page, { timeout: 120000 });

  const filenameBase = [
    'operation_wise_analysis',
    sanitizeName(reportType),
    range.startIso,
    'to',
    range.endIso
  ].join('_');

  const chunkDir = path.join(outputDir, sanitizeName(reportType), `${range.startIso}_to_${range.endIso}`);
  const pageFiles = await exportAllGridPagesToFiles(page, {
    outputDir: chunkDir,
    filenameBase,
    pageSize: config.operationWiseAnalysisPageSize,
    maxPages: 1000
  });

  logger.info('[Operation Wise Analysis Report] Chunk export completed', {
    reportType,
    startDate: range.startIso,
    endDate: range.endIso,
    pageCount: pageFiles.length
  });

  const merged = await mergeExcelFiles(pageFiles);
  const dataset = addReportMetadataToDataset(reportType, range, merged);
  const dbResult = await saveReportSheetToRelationalTable({
    sheetName: config.operationWiseAnalysisSheetName,
    headers: dataset.headers,
    rows: dataset.rows
  });

  await cleanupReportExportDir(chunkDir);

  logger.info('[Operation Wise Analysis Report] Chunk saved to relational table', {
    reportType,
    tableName: dbResult.tableName,
    reportMonth: range.reportMonthIso,
    startDate: range.startIso,
    endDate: range.endIso,
    pageCount: pageFiles.length,
    incomingRowCount: dbResult.incomingRowCount,
    insertedRowCount: dbResult.insertedRowCount,
    duplicateRowCount: dbResult.duplicateRowCount,
    invalidDates: dbResult.invalidDates,
    invalidNumerics: dbResult.invalidNumerics
  });

  return {
    reportType,
    dateRange: range,
    pageCount: pageFiles.length,
    headerCount: dataset.headers.length,
    rowCount: dataset.rows.length,
    dbResult
  };
}

async function runReportType(page, {
  reportType,
  chunks,
  outputDir
}) {
  await ensureReportType(page, reportType);

  const results = [];
  for (const [index, range] of chunks.entries()) {
    logger.info('[Operation Wise Analysis Report] Chunk started', {
      reportType,
      chunkNumber: index + 1,
      chunkCount: chunks.length,
      reportMonth: range.reportMonthIso,
      startDate: range.startIso,
      endDate: range.endIso
    });

    const result = await exportChunkToRelationalTable(page, {
      reportType,
      range,
      outputDir
    });
    results.push(result);

    if (index < chunks.length - 1) {
      if (config.operationWiseAnalysisBetweenChunksDelayMs > 0) {
        await sleep(config.operationWiseAnalysisBetweenChunksDelayMs);
      }
    }
  }

  return results;
}

export async function downloadOperationWiseAnalysisReportOptimized(page, { dealerCode, account, startIso, endIso }) {
  logger.info('Operation Wise Analysis Report optimized backfill started', {
    dealerCode,
    startIso,
    endIso,
    mode: 'full-range-no-search'
  });
  await openAdvWiseLubricantsVasReport(page);
  const reportContext = await resolveOperationWiseAnalysisContext(page);

  await ensureBillingDateType(reportContext);
  await ensureReportType(reportContext, 'Operation');

  const startDate = parseIsoLocalDate(startIso);
  const endDate = parseIsoLocalDate(endIso);
  const range = buildChunk(startDate, endDate);

  logger.info('Operation Wise Analysis Report applying full date range (optimized)', {
    startDate: range.startPortal,
    endDate: range.endPortal,
    mode: 'skip-search-direct-page-size'
  });

  await fillOperationWiseAnalysisDateRange(reportContext, range, 'Operation');

  // OPTIMIZATION: Skip search button click - just select page size
  // This causes grid to auto-load all data for the entire date range
  logger.info('Operation Wise Analysis Report selecting page size without search click', {
    pageSize: '1000',
    mode: 'full-range-auto-load'
  });
  
  await selectKendoPagerSize(reportContext, '1000');
  await waitForKendoGridIdle(reportContext, { timeout: 300000 }); // Wait up to 5 min for 200k+ rows

  const exportDir = path.join(config.reportChunksDir, 'am-platinum', 'operation-wise-analysis-report', dealerCode, `${startIso}_to_${endIso}`);
  
  logger.info('Operation Wise Analysis Report exporting all pages', {
    expectedRowCount: '200000+',
    pageSize: 1000
  });
  
  const pageFiles = await exportAllGridPagesToFiles(reportContext, {
    outputDir: exportDir,
    filenameBase: `operation_wise_analysis_report_${dealerCode}_${startIso}_to_${endIso}`,
    pageSize: 1000,
    downloadTimeoutMs: 60000
  });

  logger.info('Operation Wise Analysis Report merging exported pages', {
    pageCount: pageFiles.length
  });
  
  const merged = pageFiles.length
    ? await mergeExcelFiles(pageFiles)
    : { headers: [], rows: [] };
  
  const withMetadata = addReportMetadataToDataset('Operation', range, merged);
  const withDealer = withMetadata.rows.length
    ? { ...withMetadata, rows: withMetadata.rows.map(row => ({ ...row, source_dealer_code: dealerCode })) }
    : withMetadata;

  if (!withDealer.rows.length) {
    logger.info('Operation Wise Analysis Report had no rows; skipping Supabase save', {
      dealerCode
    });
    await cleanupReportExportDir(exportDir);
    return {
      sheetName: 'AM Platinum Operation Wise Analysis Report',
      dbResult: { action: 'no_rows', rowCount: 0 },
      pageCount: pageFiles.length
    };
  }

  const dbResult = await saveReportSheetToRelationalTable({
    sheetName: 'AM Platinum Operation Wise Analysis Report',
    brand: 'am_platinum',
    headers: withDealer.headers,
    rows: withDealer.rows
  });

  await cleanupReportExportDir(exportDir);

  logger.info('Operation Wise Analysis Report optimized backfill finished', {
    dealerCode,
    dbAction: dbResult.action,
    rowCount: withDealer.rows.length,
    pageCount: pageFiles.length
  });

  return {
    sheetName: 'AM Platinum Operation Wise Analysis Report',
    dbResult: { ...dbResult, rowCount: withDealer.rows.length },
    pageCount: pageFiles.length
  };
}

export async function downloadOperationWiseAnalysisReport(page) {
  logger.info('Operation Wise Analysis Report started');
  await openAdvWiseLubricantsVasReport(page);
  const reportContext = await resolveOperationWiseAnalysisContext(page);

  const monthRange = getCurrentMonthToDateRange();
  const overrideRange = getReportDateOverrideRange();
  const startDate = overrideRange?.startDate ?? (config.historicalBackfillEnabled
    ? parseIsoLocalDate(config.historicalBackfillStartDate)
    : config.operationWiseAnalysisBackfillEnabled
      ? parseIsoLocalDate(config.operationWiseAnalysisBackfillStartDate)
      : monthRange.startDate);
  const endDate = overrideRange?.endDate ?? monthRange.endDate;
  const chunks = getMonthlyThirtyDayChunks(startDate, endDate);
  const reportTypes = getReportTypesToRun();
  const outputDir = buildRunDir();
  await fs.mkdir(outputDir, { recursive: true });

  logger.info('Operation Wise Analysis Report date chunks prepared', {
    mode: overrideRange ? 'date-override' : (config.historicalBackfillEnabled || config.operationWiseAnalysisBackfillEnabled) ? 'historical-backfill' : 'current-month',
    startDate: toIsoDate(startDate),
    endDate: toIsoDate(endDate),
    chunkCount: chunks.length,
    reportTypes
  });

  const allResults = [];
  try {
    for (const reportType of reportTypes) {
      const reportTypeResults = await runReportType(reportContext, {
        reportType,
        chunks,
        outputDir
      });
      allResults.push(...reportTypeResults);
    }
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }

  const insertedRowCount = allResults.reduce((total, result) =>
    total + Number(result.dbResult?.insertedRowCount ?? 0), 0);
  const duplicateRowCount = allResults.reduce((total, result) =>
    total + Number(result.dbResult?.duplicateRowCount ?? 0), 0);
  const rowCount = allResults.reduce((total, result) =>
    total + Number(result.rowCount ?? 0), 0);
  const pageCount = allResults.reduce((total, result) =>
    total + Number(result.pageCount ?? 0), 0);

  logger.info('Operation Wise Analysis Report finished', {
    sheetName: config.operationWiseAnalysisSheetName,
tableName: 'am_platinum_operation_wise_analysis_report',
    chunkResultCount: allResults.length,
    rowCount,
    pageCount,
    insertedRowCount,
    duplicateRowCount
  });

  return {
    name: 'Operation Wise Analysis Report',
    sheetName: config.operationWiseAnalysisSheetName,
    dateRange: {
      startIso: toIsoDate(startDate),
      endIso: toIsoDate(endDate)
    },
    dbResult: {
      action: 'relational-batched-backfill',
tableName: 'am_platinum_operation_wise_analysis_report',
      rowCount,
      pageCount,
      insertedRowCount,
      duplicateRowCount,
      chunkResultCount: allResults.length
    }
  };
}
