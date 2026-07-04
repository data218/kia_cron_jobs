import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  resolveAmPlatinumSourceDealerCode
} from '../accounts/am-platinum-accounts.js';
import { openAdvWiseLubricantsVasReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToRelationalTable, normalizeTableName } from '../supabase/relational-store.js';
import { withPostgresClient } from '../supabase/postgres.js';
import {
  formatDateForPortal,
  parseIsoLocalDate,
  toIsoDate
} from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { selectKendoPagerSizeWithPreferredFallback, waitForKendoGridIdle } from './grid.js';
import {
  cleanupReportExportDir,
  exportAllGridPagesToFiles,
  gridHasNoExportableData,
  mergeExcelFiles
} from './paged-export.js';
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByInputId
} from './report-actions.js';
import { sleep } from '../utils/sleep.js';
import {
  buildRangeFromIsoDates,
  exactPeriodExists,
  getCurrentYearToDateRange,
  getLastYearComparableRange,
  OPERATION_WISE_REPORT_TYPES
} from '../am-platinum/comparable-period.js';

const SHEET_NAME = 'AM Platinum Operation Wise Analysis Report';
const TABLE_NAME = normalizeTableName(SHEET_NAME);
const PREFERRED_PAGE_SIZES = ['1000', '500', '300'];

function sanitizeName(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isActiveDealerAlias(dealerCode) {
  return !dealerCode || ['active', 'current', 'default'].includes(String(dealerCode).trim().toLowerCase());
}

export async function resolveOperationWiseContext(page) {
  const context = await findContextWithVisibleSelector(page, '#startDate', {
    timeout: 90000,
    label: 'Operation Wise Analysis Report Start Date (AM Platinum)'
  });
  await context.locator('#endDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#reportType').first().waitFor({ state: 'attached', timeout: 30000 });
  await context.locator('#dateType').first().waitFor({ state: 'attached', timeout: 30000 });
  return context;
}

async function ensureDropdownValue(context, inputId, value) {
  try {
    const widget = context.locator(
      `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]`
    ).first();
    const currentText = await widget.locator('.k-input').first().innerText({ timeout: 5000 })
      .then(text => text.trim())
      .catch(() => '');
    if (currentText === value) {
      return;
    }
  } catch {
    // fall through to set value
  }

  await selectKendoDropdownByInputId(context, inputId, value);
  await waitForKendoGridIdle(context, { timeout: 120000 });
}

function addReportMetadata(reportType, range, dataset, dealerCode) {
  const metadataHeaders = [
    'report_type',
    'report_month',
    'report_period_start',
    'report_period_end',
    'source_dealer_code'
  ];
  const headers = [
    ...metadataHeaders,
    ...dataset.headers.filter(header => !metadataHeaders.includes(header))
  ];
  const storeDealerCode = resolveAmPlatinumSourceDealerCode(dealerCode, range);
  const dealerVal = isActiveDealerAlias(storeDealerCode)
    ? ''
    : String(storeDealerCode).trim().toUpperCase();

  const rows = dataset.rows.map(row => ({
    report_type: reportType,
    report_month: range.reportMonthIso,
    report_period_start: range.startIso,
    report_period_end: range.endIso,
    source_dealer_code: dealerVal || row.source_dealer_code || row.dealer_code || '',
    ...row
  }));

  return { headers, rows };
}

async function ensureOperationWisePagerSize(context) {
  const selectedPageSize = await selectKendoPagerSizeWithPreferredFallback(
    context,
    PREFERRED_PAGE_SIZES,
    { visibleClick: true, timeout: 300000 }
  );
  await waitForKendoGridIdle(context, { timeout: 120000 });
  return Number(selectedPageSize);
}

export async function exportOperationWiseTypeAndRange(context, {
  reportType,
  range,
  dealerCode,
  outputDir = path.join(config.amPlatinumReportChunksDir, 'operation-wise-slice', sanitizeName(dealerCode))
}) {
  await ensureDropdownValue(context, 'dateType', 'Billing Date');
  await ensureDropdownValue(context, 'reportType', reportType);
  await fillDate(context, '#endDate', range.endPortal);
  await fillDate(context, '#startDate', range.startPortal);
  await clickSearch(context);
  await waitForKendoGridIdle(context, { timeout: 120000 });

  if (config.operationWiseAnalysisPostSearchDelayMs > 0) {
    await sleep(config.operationWiseAnalysisPostSearchDelayMs);
  }

  const emptyCheck = await gridHasNoExportableData(context, PREFERRED_PAGE_SIZES[0]);
  if (emptyCheck.noData) {
    logger.info('Operation wise slice has no data', {
      dealerCode,
      reportType,
      rangeStart: range.startIso,
      rangeEnd: range.endIso,
      ...emptyCheck
    });
    return {
      action: 'no_rows',
      rowCount: 0,
      reportType,
      range
    };
  }

  const selectedPageSize = await ensureOperationWisePagerSize(context);
  const exportDir = path.join(
    outputDir,
    sanitizeName(reportType),
    `${range.startIso}_to_${range.endIso}`
  );
  const filenameBase = [
    'operation_wise_analysis',
    sanitizeName(reportType),
    range.startIso,
    'to',
    range.endIso
  ].join('_');

  const pageFiles = await exportAllGridPagesToFiles(context, {
    outputDir: exportDir,
    filenameBase,
    pageSize: selectedPageSize,
    maxPages: 500,
    downloadTimeoutMs: 120000
  });

  if (!pageFiles.length) {
    await cleanupReportExportDir(exportDir).catch(() => {});
    return {
      action: 'no_rows',
      rowCount: 0,
      reportType,
      range
    };
  }

  const merged = await mergeExcelFiles(pageFiles);
  if (!merged.rows.length) {
    await cleanupReportExportDir(exportDir).catch(() => {});
    return {
      action: 'no_rows',
      rowCount: 0,
      reportType,
      range
    };
  }

  const dataset = addReportMetadata(reportType, range, merged, dealerCode);
  const dbResult = await saveReportSheetToRelationalTable({
    sheetName: SHEET_NAME,
    headers: dataset.headers,
    rows: dataset.rows
  });

  await cleanupReportExportDir(exportDir).catch(() => {});

  return {
    action: 'saved',
    rowCount: dataset.rows.length,
    insertedRowCount: dbResult.insertedRowCount ?? dataset.rows.length,
    reportType,
    range,
    dbResult
  };
}

export async function exportOperationWiseRangesForDealer(page, {
  dealerCode,
  ranges,
  reportTypes = OPERATION_WISE_REPORT_TYPES,
  skipExisting = true
}) {
  await openAdvWiseLubricantsVasReport(page);
  const context = await resolveOperationWiseContext(page);
  const results = [];

  for (const range of ranges) {
    for (const reportType of reportTypes) {
      if (skipExisting) {
        const existingRows = await withPostgresClient(client =>
          exactPeriodExists(client, {
            dealerCode,
            reportType,
            periodStart: range.startIso,
            periodEnd: range.endIso
          })
        );

        if (existingRows > 0) {
          results.push({
            action: 'skipped_existing',
            rowCount: existingRows,
            reportType,
            range
          });
          continue;
        }
      }

      const result = await exportOperationWiseTypeAndRange(context, {
        reportType,
        range,
        dealerCode
      });
      results.push(result);
    }
  }

  return results;
}

export async function runAmPlatinumOperationWiseForDealer(page, {
  dealerCode,
  account,
  cyRange = getCurrentYearToDateRange(),
  skipExisting = true
}) {
  logger.info('AM Platinum operation wise CY+LY export started', {
    dealerCode,
    cyRange: `${cyRange.startIso} to ${cyRange.endIso}`
  });

  const lyRange = getLastYearComparableRange(cyRange.startIso, cyRange.endIso);
  const cyResults = await exportOperationWiseRangesForDealer(page, {
    dealerCode,
    ranges: [buildRangeFromIsoDates(cyRange.startIso, cyRange.endIso)],
    skipExisting
  });

  const lyResults = await exportOperationWiseRangesForDealer(page, {
    dealerCode,
    ranges: [lyRange],
    skipExisting
  });

  const allResults = [...cyResults, ...lyResults];
  const rowCount = allResults.reduce((sum, result) => sum + Number(result.rowCount ?? 0), 0);
  const insertedRowCount = allResults.reduce((sum, result) =>
    sum + Number(result.insertedRowCount ?? 0), 0);

  return {
    name: 'Hyundai Operation Wise Analysis Report',
    sheetName: account.sheetName('Hyundai Operation Wise Analysis Report'),
    dateRange: {
      startIso: cyRange.startIso,
      endIso: cyRange.endIso,
      lyStartIso: lyRange.startIso,
      lyEndIso: lyRange.endIso
    },
    dbResult: {
      action: 'relational-cy-ly-save',
      rowCount,
      insertedRowCount,
      chunkResultCount: allResults.length,
      results: allResults
    }
  };
}
