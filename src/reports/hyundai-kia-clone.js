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
  toIsoDate
} from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSizeWithPreferredFallback, waitForKendoGridIdle } from './grid.js';
import { exportAllGridPagesToFiles, getPagerState, gridHasNoExportableData, mergeExcelFiles } from './paged-export.js';
import { addMetadataToDataset, addSourceDealerCodeToDataset } from './report-metadata.js';
import {
  clickSearch,
  fillDate,
  getKendoDropdownOptionsByInputId,
  selectKendoDropdownByInputId,
  selectKendoDropdownByLabel
} from './report-actions.js';

function sanitizeName(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function reportAccount(report) {
  return report.account ?? createGdmsAccountProfile('hmil');
}

function buildRunDir(account, reportId, range, dealerCode, suffix = '') {
  const now = new Date();
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('-');

  return path.join(
    account.reportChunksDir,
    sanitizeName(reportId),
    sanitizeName(dealerCode || 'active'),
    [
      `${range.startIso}_to_${range.endIso}_${time}`,
      suffix ? sanitizeName(suffix) : ''
    ].filter(Boolean).join('_')
  );
}

function filenameBase(reportId, range, dealerCode, suffix = '') {
  return [
    sanitizeName(reportId),
    sanitizeName(dealerCode || 'active'),
    suffix ? sanitizeName(suffix) : '',
    range.startIso.replaceAll('-', '_'),
    'to',
    range.endIso.replaceAll('-', '_')
  ].filter(Boolean).join('_');
}

function failureTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function captureLoopFailureScreenshot(page, report, dealerCode, loopValue) {
  const screenshotPath = path.join(
    config.screenshotsDir,
    [
      sanitizeName(report.id),
      sanitizeName(dealerCode || 'active'),
      loopValue ? sanitizeName(loopValue) : 'loop',
      `failure_${failureTimestamp()}.png`
    ].join('_')
  );

  try {
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch (error) {
    logger.warn('Could not capture Hyundai loop failure screenshot', {
      reportId: report.id,
      dealerCode,
      loopValue,
      error: error.message
    });
    return null;
  }
}

function currentMonthFullRange(today = new Date()) {
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1);
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

function getRange(rangeType) {
  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return overrideRange;
  }

  if (rangeType === 'current-month-full') {
    return currentMonthFullRange();
  }

  return getCurrentMonthToDateRange();
}

async function cleanupHyundaiExportDir(exportDir, account = createGdmsAccountProfile('hmil')) {
  const resolvedExportDir = path.resolve(exportDir);
  const resolvedChunksRoot = path.resolve(account.reportChunksDir);

  if (!resolvedExportDir.startsWith(`${resolvedChunksRoot}${path.sep}`)) {
    throw new Error(`Refusing to delete ${account.logPrefix} export directory outside chunks root: ${resolvedExportDir}`);
  }

  await fs.rm(resolvedExportDir, { recursive: true, force: true });
  logger.info(`Deleted local ${account.logPrefix} mirrored report export files after successful Supabase upload`, {
    exportDir: resolvedExportDir
  });
}

async function selectDropdownIfConfigured(context, dropdown) {
  if (!dropdown) return;

  if (dropdown.label) {
    await selectKendoDropdownByLabel(context, dropdown.label, dropdown.value, {
      timeout: dropdown.timeout ?? 30000
    });
    return;
  }

  await selectKendoDropdownByInputId(context, dropdown.inputId, dropdown.value, {
    timeout: dropdown.timeout ?? 30000
  });
}

async function fillDateRange(context, report, range) {
  logger.info('Applying Hyundai mirrored report date range', {
    reportId: report.id,
    startDate: range.startPortal,
    endDate: range.endPortal,
    fromSelector: report.dateFromSelector,
    toSelector: report.dateToSelector
  });

  await fillDate(context, report.dateToSelector, range.endPortal);
  await fillDate(context, report.dateFromSelector, range.startPortal);
}

async function fillStartDateOnly(context, report, range) {
  logger.info('Applying Hyundai mirrored report start date only', {
    reportId: report.id,
    startDate: range.startPortal,
    fromSelector: report.dateFromSelector,
    toSelector: report.dateToSelector
  });

  await fillDate(context, report.dateFromSelector, range.startPortal);
}

async function selectPagerSizeWithFallback(context, size, reportId, { visibleClick = false } = {}) {
  return selectKendoPagerSizeWithPreferredFallback(
    context,
    ['1000', '500', '300'],
    {
      visibleClick,
      timeout: visibleClick ? 300000 : 45000
    }
  );
}

async function getLoopValues(context, report) {
  if (!report.loopDropdown) {
    return [null];
  }

  const values = await getKendoDropdownOptionsByInputId(context, report.loopDropdown.inputId, {
    timeout: report.loopDropdown.timeout ?? 30000,
    excludeValues: report.loopDropdown.excludeValues ?? []
  });

  if (!values.length) {
    logger.warn('No loop dropdown values found for Hyundai mirrored report; running current selection once', {
      reportId: report.id,
      inputId: report.loopDropdown.inputId
    });
    return [null];
  }

  return values;
}

function aggregateResults(results) {
  const insertedRows = results.reduce((sum, result) => (
    sum + (
      result.dbResult?.insertedRowCount ??
      result.dbResult?.relationalInsertedRowCount ??
      result.dbResult?.relationalResult?.insertedRowCount ??
      0
    )
  ), 0);
  const duplicateRows = results.reduce((sum, result) => (
    sum + (
      result.dbResult?.duplicateRowCount ??
      result.dbResult?.relationalDuplicateRowCount ??
      result.dbResult?.relationalResult?.duplicateRowCount ??
      0
    )
  ), 0);

  return { insertedRows, duplicateRows };
}

export function createHyundaiKiaCloneReport(report) {
  return async function downloadHyundaiKiaCloneReport(page, {
    dealerCode = 'active',
    range: suppliedRange,
    skipNavigation = false,
    optimizedNoSearch = false,
    pageSize: suppliedPageSize,
    maxPages: suppliedMaxPages
  } = {}) {
    const account = reportAccount(report);
    const range = suppliedRange ?? getRange(report.rangeType);

    logger.info(`${account.logPrefix} mirrored KIA report started`, {
      reportId: report.id,
      reportName: report.name,
      sheetName: report.sheetName,
      dealerCode,
      range: `${range.startIso} to ${range.endIso}`,
      optimizedNoSearch
    });

    if (!skipNavigation) {
      await report.open(page);
    }

    const reportContext = await findContextWithVisibleSelector(page, report.readySelector ?? report.dateFromSelector, {
      timeout: report.readyTimeoutMs ?? 90000,
      label: `${report.name} ready selector`
    });
    await reportContext.locator(report.dateToSelector).first().waitFor({
      state: 'visible',
      timeout: 30000
    });

    for (const dropdown of report.preDateDropdowns ?? []) {
      await selectDropdownIfConfigured(reportContext, dropdown);
    }

    const loopValues = await getLoopValues(reportContext, report);
    const results = [];
    const failedLoops = [];
    let totalRows = 0;
    let totalHeaders = 0;
    let totalPages = 0;

    for (const loopValue of loopValues) {
      const loopLabel = loopValue ?? '';

      try {
        if (report.loopDropdown && loopValue) {
          await selectKendoDropdownByInputId(reportContext, report.loopDropdown.inputId, loopValue, {
            timeout: report.loopDropdown.timeout ?? 30000
          });
        }

        if (optimizedNoSearch) {
          await fillStartDateOnly(reportContext, report, range);
        } else {
          await fillDateRange(reportContext, report, range);
        }

        for (const dropdown of report.preSearchDropdowns ?? []) {
          await selectDropdownIfConfigured(reportContext, dropdown);
        }

        if (optimizedNoSearch) {
          logger.info(`${account.logPrefix} optimized historical export: skipping Search and selecting pager size`, {
            reportId: report.id,
            dealerCode,
            loopValue,
            startDate: range.startPortal,
            requestedPageSize: suppliedPageSize ?? report.pageSize ?? '1000'
          });
        } else {
          await clickSearch(reportContext);
          await waitForKendoGridIdle(reportContext, { timeout: 120000 });

          if (report.postSearchDelayMs > 0) {
            logger.info(`Waiting briefly after ${account.logPrefix} mirrored report search`, {
              reportId: report.id,
              delayMs: report.postSearchDelayMs
            });
            await sleep(report.postSearchDelayMs);
          }
        }

        const requestedPageSize = suppliedPageSize ?? report.pageSize ?? (optimizedNoSearch ? '1000' : '300');
        const emptyCheck = optimizedNoSearch
          ? { noData: false }
          : await gridHasNoExportableData(reportContext, requestedPageSize);

        if (emptyCheck.noData) {
          logger.info(`${account.logPrefix} mirrored report month has no data; skipping pager size and export`, {
            reportId: report.id,
            dealerCode,
            loopValue,
            range: `${range.startIso} to ${range.endIso}`,
            totalItems: emptyCheck.totalItems,
            visibleRowCount: emptyCheck.visibleRowCount,
            hasNoDataMessage: emptyCheck.hasNoDataMessage
          });

          const emptyResult = {
            action: 'no_rows',
            rowCount: 0,
            headerCount: 0,
            addedRowCount: 0,
            duplicateRowCount: 0,
            relationalInsertedRowCount: 0,
            relationalDuplicateRowCount: 0
          };

          results.push({
            dbResult: emptyResult,
            rowCount: 0,
            headerCount: 0,
            pageCount: 0
          });
          continue;
        }

        const selectedPageSize = await selectPagerSizeWithFallback(
          reportContext,
          requestedPageSize,
          report.id,
          { visibleClick: true }
        );

        await waitForKendoGridIdle(reportContext, { timeout: optimizedNoSearch ? 300000 : 120000 });
        const pagerState = await getPagerState(reportContext, selectedPageSize);
        logger.info(`${account.logPrefix} mirrored report grid ready for export`, {
          reportId: report.id,
          dealerCode,
          loopValue,
          optimizedNoSearch,
          totalItems: pagerState.totalItems,
          totalPages: pagerState.totalPages,
          pageSize: pagerState.pageSize
        });

        const outputDir = buildRunDir(account, report.id, range, dealerCode, loopLabel);
        const baseName = filenameBase(report.id, range, dealerCode, loopLabel);
        const pageFiles = await exportAllGridPagesToFiles(reportContext, {
          outputDir,
          filenameBase: baseName,
          pageSize: selectedPageSize,
          downloadTimeoutMs: report.downloadTimeoutMs ?? 30000,
          maxPages: suppliedMaxPages ?? (optimizedNoSearch ? 30000 : 500)
        });
        const parsed = pageFiles.length
          ? await mergeExcelFiles(pageFiles, report.parseOptions ?? {})
          : { headers: [], rows: [] };
        const withDealer = report.addSourceDealerCode === false
          ? parsed
          : addSourceDealerCodeToDataset(parsed, dealerCode);
        const metadata = {
          ...(report.metadata ?? {}),
          ...(report.loopDropdown && loopValue
            ? { [report.loopDropdown.metadataHeader ?? `${report.loopDropdown.inputId}_filter`]: loopValue }
            : {})
        };
        const merged = Object.keys(metadata).length
          ? addMetadataToDataset(withDealer, metadata, { range })
          : withDealer;

        if (!merged.rows.length && !report.saveEmptyDataset) {
          await cleanupHyundaiExportDir(outputDir, account);

          const emptyResult = {
            action: 'no_rows',
            rowCount: 0,
            headerCount: merged.headers.length,
            addedRowCount: 0,
            duplicateRowCount: 0,
            relationalInsertedRowCount: 0,
            relationalDuplicateRowCount: 0
          };

          results.push({
            dbResult: emptyResult,
            rowCount: 0,
            headerCount: merged.headers.length,
            pageCount: pageFiles.length
          });
          totalHeaders = Math.max(totalHeaders, merged.headers.length);
          totalPages += pageFiles.length;

          logger.info(`${account.logPrefix} mirrored KIA report loop had no rows; skipped Supabase save`, {
            reportId: report.id,
            reportName: report.name,
            sheetName: report.sheetName,
            dealerCode,
            loopValue,
            headerCount: merged.headers.length,
            pageCount: pageFiles.length
          });
          continue;
        }

        const dbResult = await saveReportSheetToSupabase({
          brand: account.brand,
          sheetName: report.sheetName,
          headers: merged.headers,
          rows: merged.rows
        });

        await cleanupHyundaiExportDir(outputDir, account);

        results.push({
          dbResult,
          rowCount: merged.rows.length,
          headerCount: merged.headers.length,
          pageCount: pageFiles.length
        });
        totalRows += merged.rows.length;
        totalHeaders = Math.max(totalHeaders, merged.headers.length);
        totalPages += pageFiles.length;

        logger.info(`${account.logPrefix} mirrored KIA report loop finished`, {
          reportId: report.id,
          reportName: report.name,
          sheetName: report.sheetName,
          dealerCode,
          loopValue,
          dbAction: dbResult.action,
          rowCount: merged.rows.length,
          headerCount: merged.headers.length,
          pageCount: pageFiles.length
        });
      } catch (error) {
        if (!report.loopDropdown) {
          throw error;
        }

        const screenshotPath = await captureLoopFailureScreenshot(page, report, dealerCode, loopValue);
        const failedLoop = {
          loopValue,
          message: error.message,
          stack: error.stack,
          screenshotPath
        };
        failedLoops.push(failedLoop);

        logger.error(`${account.logPrefix} mirrored report loop failed; continuing with next loop value`, {
          reportId: report.id,
          reportName: report.name,
          sheetName: report.sheetName,
          dealerCode,
          loopValue,
          screenshotPath,
          err: {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        });
      }
    }

    const { insertedRows, duplicateRows } = aggregateResults(results);
    const dbResult = results.at(-1)?.dbResult ?? {};

    logger.info(`${account.logPrefix} mirrored KIA report finished`, {
      reportId: report.id,
      reportName: report.name,
      sheetName: report.sheetName,
      dealerCode,
      loopCount: loopValues.length,
      rowCount: totalRows,
      headerCount: totalHeaders,
      pageCount: totalPages,
      insertedRows,
      duplicateRows,
      failedLoopCount: failedLoops.length,
      failedLoops: failedLoops.map(loop => ({
        loopValue: loop.loopValue,
        message: loop.message,
        screenshotPath: loop.screenshotPath
      }))
    });

    return {
      name: report.name,
      id: report.id,
      sheetName: report.sheetName,
      dealerCode,
      dbResult: {
        ...dbResult,
        action: report.loopDropdown ? `${account.id}-looped-relational-save` : dbResult.action,
        rowCount: totalRows,
        headerCount: totalHeaders,
        pageCount: totalPages,
        insertedRowCount: insertedRows,
        duplicateRowCount: duplicateRows,
        failedLoopCount: failedLoops.length,
        failedLoops
      },
      range,
      failedLoops
    };
  };
}
