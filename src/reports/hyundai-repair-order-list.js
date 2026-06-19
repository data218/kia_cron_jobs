import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createGdmsAccountProfile } from '../accounts/gdms-account-profile.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import {
  formatDateForPortal,
  getCurrentMonthToDateRange,
  getReportDateOverrideRange,
  parseIsoLocalDate,
  toIsoDate
} from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { openHmilRepairOrderListReport } from '../navigation/hmil-menu.js';
import { selectKendoPagerSizeWithPreferredFallback, waitForKendoGridIdle } from './grid.js';
import { exportAllGridPagesToFiles, gridHasNoExportableData, mergeExcelFiles } from './paged-export.js';
import { addSourceDealerCodeToDataset } from './report-metadata.js';
import { clickSearch, fillDate } from './report-actions.js';

function buildRunDir(account, range, dealerCode) {
  const now = new Date();
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('-');

  return path.join(
    account.reportChunksDir,
    'hyundai-repair-order-list',
    String(dealerCode || 'active').toLowerCase(),
    `${range.startIso}_to_${range.endIso}_${time}`
  );
}

function filenameBase(account, range, dealerCode) {
  return `${account.id.replace(/-/g, '_')}_repair_order_${String(dealerCode || 'active').toLowerCase()}_${range.startIso.replaceAll('-', '_')}_to_${range.endIso.replaceAll('-', '_')}`;
}

async function cleanupHmilExportDir(exportDir, account) {
  const resolvedExportDir = path.resolve(exportDir);
  const resolvedChunksRoot = path.resolve(account.reportChunksDir);

  if (!resolvedExportDir.startsWith(`${resolvedChunksRoot}${path.sep}`)) {
    throw new Error(`Refusing to delete ${account.logPrefix} export directory outside chunks root: ${resolvedExportDir}`);
  }

  await fs.rm(resolvedExportDir, { recursive: true, force: true });
  logger.info(`Deleted local ${account.logPrefix} report export files after successful Supabase upload`, {
    exportDir: resolvedExportDir
  });
}

async function resolveRepairOrderContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sRoDateFromDate', {
    timeout: 90000,
    label: 'Hyundai Repair Order RO Date From'
  });

  await context.locator('#sRoDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Hyundai Repair Order List page loaded');
  return context;
}

function configuredRange(account) {
  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return overrideRange;
  }

  if (account.id === 'am-platinum' && account.currentMonthOnly) {
    return getCurrentMonthToDateRange();
  }

  const startDate = parseIsoLocalDate(account.repairOrderStartDate);
  const endDate = parseIsoLocalDate(account.repairOrderEndDate);

  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

async function fillRepairOrderDateRange(context, range) {
  logger.info('Applying Hyundai Repair Order date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  // Fill end first so DMS never sees a temporary start date after the end date.
  await fillDate(context, '#sRoDateToDate', range.endPortal);
  await fillDate(context, '#sRoDateFromDate', range.startPortal);
}

async function fillRepairOrderStartDateOnly(context, range) {
  logger.info('Applying Hyundai Repair Order start date only', {
    startDate: range.startPortal
  });

  await fillDate(context, '#sRoDateFromDate', range.startPortal);
}

export async function downloadHyundaiRepairOrderListReport(
  page,
  {
    dealerCode = 'active',
    account = createGdmsAccountProfile('hmil'),
    range: suppliedRange,
    skipNavigation = false,
    optimizedNoSearch = false,
    pageSize: suppliedPageSize,
    maxPages: suppliedMaxPages
  } = {}
) {
  logger.info(`${account.logPrefix} Repair Order List report started`, { dealerCode });
  if (!skipNavigation) {
    await openHmilRepairOrderListReport(page);
  }
  const reportContext = await resolveRepairOrderContext(page);
  const range = suppliedRange ?? configuredRange(account);
  const outputDir = buildRunDir(account, range, dealerCode);
  const baseName = filenameBase(account, range, dealerCode);

  await fillRepairOrderDateRange(reportContext, range);

  logger.info(`${account.logPrefix} Repair Order List: toggling pager size (first selecting 50/100, then 1000/300) to trigger load`, {
    dealerCode,
    range: `${range.startIso} to ${range.endIso}`
  });

  try {
    logger.info('Toggling intermediate pager size to 50/100...');
    await selectKendoPagerSizeWithPreferredFallback(
      reportContext,
      ['50', '100'],
      {
        visibleClick: true,
        timeout: 15000
      }
    );
    await sleep(1500);
  } catch (err) {
    logger.warn('Failed to select intermediate pager size; continuing directly to target size', { error: err.message });
  }

  const selectedPageSize = await selectKendoPagerSizeWithPreferredFallback(
    reportContext,
    ['1000', '300'],
    {
      visibleClick: true,
      timeout: 120000
    }
  );
  await sleep(3000);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  const emptyCheck = await gridHasNoExportableData(reportContext, selectedPageSize);
  if (emptyCheck.noData) {
    logger.info(`${account.logPrefix} Repair Order List report has no data; skipping export`, {
      dealerCode,
      range: `${range.startIso} to ${range.endIso}`
    });

    const dbResult = {
      action: 'no_rows',
      rowCount: 0,
      headerCount: 0,
      addedRowCount: 0,
      duplicateRowCount: 0,
      relationalInsertedRowCount: 0,
      relationalDuplicateRowCount: 0
    };

    await cleanupHmilExportDir(outputDir, account);

    logger.info(`${account.logPrefix} Repair Order List report finished (No Data)`, {
      sheetName: account.repairOrderSheetName,
      dbAction: dbResult.action,
      rowCount: 0,
      range: `${range.startIso} to ${range.endIso}`,
      dealerCode
    });

    return {
      name: 'Hyundai Repair Order List',
      sheetName: account.repairOrderSheetName,
      dbResult,
      dealerCode,
      range,
      outputDir,
      pageFiles: []
    };
  }

  const pageFiles = await exportAllGridPagesToFiles(reportContext, {
    outputDir,
    filenameBase: baseName,
    pageSize: selectedPageSize,
    maxPages: suppliedMaxPages ?? 500
  });
  const merged = addSourceDealerCodeToDataset(await mergeExcelFiles(pageFiles), dealerCode);

  const dbResult = await saveReportSheetToSupabase({
    brand: account.brand,
    sheetName: account.repairOrderSheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupHmilExportDir(outputDir, account);

  logger.info(`${account.logPrefix} Repair Order List report finished`, {
    sheetName: account.repairOrderSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    pageCount: pageFiles.length,
    range: `${range.startIso} to ${range.endIso}`,
    dealerCode
  });

  return {
    name: 'Hyundai Repair Order List',
    sheetName: account.repairOrderSheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length
    },
    dealerCode,
    range,
    outputDir,
    pageFiles
  };
}
