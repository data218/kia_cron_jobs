import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  openHmilWarrantyClaim,
  openHmilWarrantyClaimList
} from '../navigation/hmil-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { clearRelationalTable } from '../supabase/relational-store.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import {
  formatDateForPortal,
  getCalendarMonthRanges,
  parseIsoLocalDate,
  toIsoDate
} from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSizeByVisibleClick, waitForKendoGridIdle } from './grid.js';
import {
  extractAllGridPagesFromDom,
  exportAllGridPagesToFiles,
  mergeExcelFiles
} from './paged-export.js';
import { addSourceDealerCodeToDataset } from './report-metadata.js';
import { clickSearch, getInputValue, pickKendoDateViaCalendar } from './report-actions.js';
import {
  getWarrantyClaimListCoveredMonths,
  hasWarrantyClaimYtpData
} from './hmil-warranty-resume.js';

export const HMIL_WARRANTY_CLAIM_LIST_SHEET = 'Hyundai Warranty Claim List';
export const HMIL_WARRANTY_CLAIM_YTP_SHEET = 'Hyundai Warranty Claim YTP';
export const HMIL_WARRANTY_CLAIM_YTP_REPORT_ID = 'hyundai-warranty-claim-ytp';

const BETWEEN_CHUNK_DELAY_MS = Number.parseInt(process.env.HMIL_WARRANTY_BETWEEN_CHUNKS_DELAY_MS || '1500', 10);
const YTP_GRID_IDLE_TIMEOUT_MS = Number.parseInt(process.env.HMIL_WARRANTY_YTP_GRID_IDLE_TIMEOUT_MS || '20000', 10);
const YTP_PAGER_SETTLE_TIMEOUT_MS = Number.parseInt(process.env.HMIL_WARRANTY_YTP_PAGER_SETTLE_TIMEOUT_MS || '3000', 10);

function safeName(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function getHmilWarrantyRange(mode = 'scheduled', today = new Date()) {
  if (mode !== 'historical' && mode !== 'scheduled') {
    throw new Error(`Unknown HMIL warranty mode: ${mode}. Use historical or scheduled.`);
  }

  const startDate = parseIsoLocalDate(config.hmilWarrantyHistoricalStartDate);
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

export function getHmilWarrantyMonthlyChunks(mode = 'scheduled', today = new Date()) {
  const fullRange = getHmilWarrantyRange(mode, today);
  return getCalendarMonthRanges(fullRange.startDate, fullRange.endDate);
}

export async function clearHmilWarrantyTables() {
  const results = await Promise.all([
    clearRelationalTable(HMIL_WARRANTY_CLAIM_LIST_SHEET),
    clearRelationalTable(HMIL_WARRANTY_CLAIM_YTP_SHEET)
  ]);
  logger.info('HMIL warranty relational tables cleared before full refresh', {
    tables: results.map(result => ({
      tableName: result.tableName,
      cleared: result.cleared,
      previousRowCount: result.previousRowCount
    }))
  });
  return results;
}

async function activateClaimYtpTab(context) {
  const tab = context.locator([
    'li#ro',
    '.k-tabstrip-items li:has-text("Claim YTP")',
    '[role="tab"]:has-text("Claim YTP")'
  ].join(',')).first();
  await tab.waitFor({ state: 'visible', timeout: 30000 });

  const active = await tab.evaluate(element =>
    element.classList.contains('k-state-active') ||
    element.getAttribute('aria-selected') === 'true'
  ).catch(() => false);

  if (!active) {
    await tab.click({ force: true });
  }
}

async function applyStartDate(context, report, range) {
  const input = context.locator(report.dateFromSelector).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.evaluate((element, nextValue) => {
    const [day, month, year] = String(nextValue)
      .split(/[./-]/)
      .map(part => Number.parseInt(part, 10));
    const widgetDate = new Date(year, month - 1, day);
    const win = element.ownerDocument.defaultView;
    const jquery = win?.jQuery ?? win?.$;
    const widget = jquery?.(element).data('kendoDatePicker') ??
      jquery?.(element).data('kendoMaskedTextBox') ??
      jquery?.(element).data('kendoExtMaskedDatePicker') ??
      jquery?.(element).data('extmaskeddatepicker');

    element.removeAttribute('readonly');
    if (widget?.value) {
      widget.value(widgetDate);
    }
    element.value = nextValue;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, range.startPortal);

  const actualStart = await getInputValue(context, report.dateFromSelector);
  if (actualStart.trim() !== range.startPortal) {
    throw new Error(
      `${report.name} start date did not retain expected value. ` +
      `Expected ${range.startPortal}, got ${actualStart}`
    );
  }
}

async function applyEndDateIfPresent(context, report, range) {
  if (!report.dateToSelector) {
    return;
  }

  const toInput = context.locator(report.dateToSelector).first();
  if (!(await toInput.isVisible({ timeout: 3000 }).catch(() => false))) {
    return;
  }

  await sleep(1000);
  await pickKendoDateViaCalendar(context, report.dateToSelector, range.endDate);
  const actualEnd = await getInputValue(context, report.dateToSelector);
  if (actualEnd.trim() !== range.endPortal) {
    throw new Error(
      `${report.name} end date did not retain expected value. ` +
      `Expected ${range.endPortal}, got ${actualEnd}`
    );
  }
}

async function prepareWarrantyGrid(context, report, range) {
  await applyStartDate(context, report, range);
  await applyEndDateIfPresent(context, report, range);

  await sleep(1000);
  logger.info('Running warranty report search (one calendar month max)', {
    reportId: report.id,
    startIso: range.startIso,
    endIso: range.endIso
  });
  await clickSearch(context);
  await waitForKendoGridIdle(context, {
    timeout: 120000,
    gridSelector: report.gridId ? `#${report.gridId}` : undefined
  });

  await sleep(1500);
  const selectedPageSize = await selectKendoPagerSizeByVisibleClick(
    context,
    config.hmilWarrantyPageSize,
    {
      timeout: 30000,
      resultSettleTimeoutMs: 5000,
      gridSelector: report.gridId ? `#${report.gridId}` : undefined
    }
  );
  await waitForKendoGridIdle(context, {
    timeout: 120000,
    gridSelector: report.gridId ? `#${report.gridId}` : undefined
  });
  await sleep(1500);
  return selectedPageSize;
}

async function isWarrantyGridEmpty(context, gridSelector = '#grid') {
  return context.evaluate(({ selector }) => {
    const isVisible = element => Boolean(element && (
      element.offsetWidth ||
      element.offsetHeight ||
      element.getClientRects().length
    ));
    const gridElement = document.querySelector(selector) ||
      Array.from(document.querySelectorAll('.k-grid')).find(isVisible);
    const gridText = gridElement?.innerText || '';
    if (/no\s+records|no\s+data|no\s+items/i.test(gridText)) {
      return true;
    }

    const pagerElement = gridElement?.querySelector('.k-pager-wrap, .k-grid-pager') ||
      Array.from(document.querySelectorAll('.k-pager-wrap, .k-grid-pager')).find(isVisible);
    const pagerText = pagerElement?.innerText || '';
    const totalMatch = pagerText.match(/\bof\s+([\d,]+)/i);
    if (totalMatch) {
      return Number.parseInt(totalMatch[1].replaceAll(',', ''), 10) === 0;
    }

    return false;
  }, { selector: gridSelector });
}

async function prepareWarrantyYtpGrid(context, report, range) {
  const gridSelector = report.gridId ? `#${report.gridId}` : undefined;

  await applyStartDate(context, report, range);
  await applyEndDateIfPresent(context, report, range);

  logger.info('Preparing Claim YTP grid without search', {
    reportId: report.id,
    startIso: range.startIso,
    endIso: range.endIso,
    pageSize: config.hmilWarrantyPageSize
  });

  await sleep(500);
  const selectedPageSize = await selectKendoPagerSizeByVisibleClick(
    context,
    config.hmilWarrantyPageSize,
    {
      timeout: YTP_GRID_IDLE_TIMEOUT_MS,
      resultSettleTimeoutMs: YTP_PAGER_SETTLE_TIMEOUT_MS,
      gridSelector
    }
  );
  await waitForKendoGridIdle(context, {
    timeout: YTP_GRID_IDLE_TIMEOUT_MS,
    gridSelector
  });

  const isEmpty = await isWarrantyGridEmpty(context, gridSelector || '#gridClaimYtp');
  return { selectedPageSize, isEmpty };
}

function buildOutputDir(account, report, range, dealerCode) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(
    account.reportChunksDir,
    safeName(report.id),
    safeName(account.userId),
    safeName(dealerCode || 'active'),
    `${range.startIso}_to_${range.endIso}_${stamp}`
  );
}

async function cleanupOutputDir(outputDir, account) {
  const resolvedOutputDir = path.resolve(outputDir);
  const resolvedRoot = path.resolve(account.reportChunksDir);
  if (!resolvedOutputDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to delete warranty export directory outside chunks root: ${resolvedOutputDir}`);
  }

  await fs.rm(resolvedOutputDir, { recursive: true, force: true });
}

function addSourceLogin(merged, userId) {
  const header = 'source_login_id';
  return {
    headers: merged.headers.includes(header) ? merged.headers : [header, ...merged.headers],
    rows: merged.rows.map(row => ({
      ...row,
      [header]: userId
    }))
  };
}

async function exportWarrantyChunk(context, {
  account,
  report,
  dealerCode,
  range,
  selectedPageSize
}) {
  const outputDir = buildOutputDir(account, report, range, dealerCode);
  const filenameBase = [
    safeName(report.id),
    safeName(account.userId),
    safeName(dealerCode),
    range.startIso.replaceAll('-', '_'),
    'to',
    range.endIso.replaceAll('-', '_')
  ].join('_');

  let pageFiles = [];
  let merged;
  let pageCount = 0;

  try {
    pageFiles = await exportAllGridPagesToFiles(context, {
      outputDir,
      filenameBase,
      pageSize: selectedPageSize,
      downloadTimeoutMs: 10000,
      maxPages: 500,
      exportSelector: report.exportSelector,
      exportWhenEmpty: true,
      emptyDownloadTimeoutMs: 5000,
      gridSelector: report.gridId ? `#${report.gridId}` : undefined
    });
    pageCount = pageFiles.length;
    if (pageFiles.length) {
      merged = await mergeExcelFiles(pageFiles);
    }
  } catch (error) {
    logger.warn('Hyundai Excel download was not captured; extracting loaded grid rows directly', {
      reportId: report.id,
      sourceLoginId: account.userId,
      dealerCode,
      range: `${range.startIso} to ${range.endIso}`,
      error: error.message
    });
    const extracted = await extractAllGridPagesFromDom(context, {
      pageSize: selectedPageSize,
      maxPages: 500,
      gridSelector: report.gridId ? `#${report.gridId}` : undefined
    });
    merged = {
      headers: extracted.headers,
      rows: extracted.rows
    };
    pageCount = extracted.pageCount;
  }

  if (!merged?.rows.length) {
    await cleanupOutputDir(outputDir, account);
    return {
      rowCount: 0,
      pageCount: 0,
      dbResult: {
        action: 'no_rows',
        rowCount: 0,
        headerCount: 0,
        pageCount: 0
      }
    };
  }

  merged = addSourceLogin(merged, account.userId);
  merged = addSourceDealerCodeToDataset(merged, dealerCode);
  const dbResult = await saveReportSheetToSupabase({
    brand: 'hyundai',
    sheetName: report.sheetName,
    headers: merged.headers,
    rows: merged.rows
  });
  await cleanupOutputDir(outputDir, account);

  return {
    rowCount: merged.rows.length,
    pageCount,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length,
      pageCount
    }
  };
}

function envBool(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return false;
  return ['1', 'true', 'yes', 'y'].includes(String(raw).toLowerCase());
}

async function runWarrantyClaimYtpReport(page, { account, mode, report, dealerCode = 'active', resume = false }) {
  const fullRange = getHmilWarrantyRange(mode);

  if (resume && mode === 'historical') {
    const alreadyLoaded = await hasWarrantyClaimYtpData(account.userId, dealerCode);
    if (alreadyLoaded) {
      logger.info('Claim YTP already loaded for dealer; skipping resume', {
        sourceLoginId: account.userId,
        dealerCode,
        range: `${fullRange.startIso} to ${fullRange.endIso}`
      });
      return {
        name: report.name,
        id: report.id,
        sheetName: report.sheetName,
        sourceLoginId: account.userId,
        dealerCode,
        range: fullRange,
        dbResult: {
          action: 'skipped_resume',
          rowCount: 0,
          headerCount: 0,
          pageCount: 0
        }
      };
    }
  }

  await report.open(page);

  const context = await findContextWithVisibleSelector(page, report.readySelector, {
    timeout: 90000,
    label: `${report.name} ready selector`
  });

  if (report.activate) {
    await report.activate(context);
  }

  await context.locator(report.dateFromSelector).first().waitFor({ state: 'visible', timeout: 30000 });

  logger.info('Claim YTP single-range export', {
    reportId: report.id,
    sourceLoginId: account.userId,
    dealerCode,
    range: `${fullRange.startIso} to ${fullRange.endIso}`
  });

  const { selectedPageSize, isEmpty } = await prepareWarrantyYtpGrid(context, report, fullRange);
  if (isEmpty) {
    logger.info('Claim YTP grid has no rows; moving on', {
      reportId: report.id,
      dealerCode,
      range: `${fullRange.startIso} to ${fullRange.endIso}`
    });
    return {
      name: report.name,
      id: report.id,
      sheetName: report.sheetName,
      sourceLoginId: account.userId,
      dealerCode,
      range: fullRange,
      dbResult: {
        action: 'no_rows',
        rowCount: 0,
        headerCount: 0,
        pageCount: 0
      }
    };
  }

  const chunkResult = await exportWarrantyChunk(context, {
    account,
    report,
    dealerCode,
    range: fullRange,
    selectedPageSize
  });

  logger.info('HMIL warranty report finished', {
    reportId: report.id,
    sourceLoginId: account.userId,
    dealerCode,
    sheetName: report.sheetName,
    rowCount: chunkResult.rowCount,
    pageCount: chunkResult.pageCount,
    range: `${fullRange.startIso} to ${fullRange.endIso}`
  });

  return {
    name: report.name,
    id: report.id,
    sheetName: report.sheetName,
    sourceLoginId: account.userId,
    dealerCode,
    range: fullRange,
    dbResult: chunkResult.dbResult
  };
}

async function runWarrantyClaimListReport(page, { account, mode, report, dealerCode = 'active', resume = false }) {
  const fullRange = getHmilWarrantyRange(mode);
  let monthlyChunks = getHmilWarrantyMonthlyChunks(mode);

  if (resume) {
    const coveredMonths = await getWarrantyClaimListCoveredMonths(account.userId, dealerCode);
    const originalCount = monthlyChunks.length;
    monthlyChunks = monthlyChunks.filter(range => !coveredMonths.has(range.startIso.slice(0, 7)));

    if (!monthlyChunks.length) {
      logger.info('Claim List fully covered for dealer; skipping resume', {
        sourceLoginId: account.userId,
        dealerCode,
        coveredMonths: [...coveredMonths],
        range: `${fullRange.startIso} to ${fullRange.endIso}`
      });
      return {
        name: report.name,
        id: report.id,
        sheetName: report.sheetName,
        sourceLoginId: account.userId,
        dealerCode,
        range: fullRange,
        dbResult: {
          action: 'skipped_resume',
          rowCount: 0,
          headerCount: 0,
          pageCount: 0,
          monthCount: originalCount,
          chunksWithData: 0
        }
      };
    }

    logger.info('Claim List resume plan', {
      sourceLoginId: account.userId,
      dealerCode,
      skippedMonths: originalCount - monthlyChunks.length,
      remainingMonths: monthlyChunks.length,
      nextRange: `${monthlyChunks[0].startIso} to ${monthlyChunks[monthlyChunks.length - 1].endIso}`
    });
  }

  await report.open(page);

  const context = await findContextWithVisibleSelector(page, report.readySelector, {
    timeout: 90000,
    label: `${report.name} ready selector`
  });

  if (report.activate) {
    await report.activate(context);
  }

  await context.locator(report.dateFromSelector).first().waitFor({ state: 'visible', timeout: 30000 });

  logger.info('Warranty report monthly chunk plan', {
    reportId: report.id,
    sourceLoginId: account.userId,
    dealerCode,
    fullRange: `${fullRange.startIso} to ${fullRange.endIso}`,
    monthCount: monthlyChunks.length
  });

  let totalRowCount = 0;
  let totalPageCount = 0;
  let chunksWithData = 0;
  let lastDbResult = null;

  for (const [index, range] of monthlyChunks.entries()) {
    logger.info('Warranty monthly chunk started', {
      reportId: report.id,
      dealerCode,
      chunk: `${index + 1}/${monthlyChunks.length}`,
      range: `${range.startIso} to ${range.endIso}`
    });

    const selectedPageSize = await prepareWarrantyGrid(context, report, range);
    const chunkResult = await exportWarrantyChunk(context, {
      account,
      report,
      dealerCode,
      range,
      selectedPageSize
    });

    totalRowCount += chunkResult.rowCount;
    totalPageCount += chunkResult.pageCount;
    if (chunkResult.rowCount > 0) {
      chunksWithData += 1;
      lastDbResult = chunkResult.dbResult;
    }

    logger.info('Warranty monthly chunk finished', {
      reportId: report.id,
      dealerCode,
      chunk: `${index + 1}/${monthlyChunks.length}`,
      range: `${range.startIso} to ${range.endIso}`,
      rowCount: chunkResult.rowCount
    });

    if (index < monthlyChunks.length - 1 && BETWEEN_CHUNK_DELAY_MS > 0) {
      await sleep(BETWEEN_CHUNK_DELAY_MS);
    }
  }

  logger.info('HMIL warranty report finished', {
    reportId: report.id,
    sourceLoginId: account.userId,
    dealerCode,
    sheetName: report.sheetName,
    rowCount: totalRowCount,
    pageCount: totalPageCount,
    chunksWithData,
    monthCount: monthlyChunks.length,
    range: `${fullRange.startIso} to ${fullRange.endIso}`
  });

  return {
    name: report.name,
    id: report.id,
    sheetName: report.sheetName,
    sourceLoginId: account.userId,
    dealerCode,
    range: fullRange,
    dbResult: totalRowCount > 0
      ? {
          ...lastDbResult,
          rowCount: totalRowCount,
          pageCount: totalPageCount,
          monthCount: monthlyChunks.length,
          chunksWithData
        }
      : {
          action: 'no_rows',
          rowCount: 0,
          headerCount: 0,
          pageCount: 0,
          monthCount: monthlyChunks.length,
          chunksWithData: 0
        }
  };
}

async function runWarrantyReport(page, { account, mode, report, dealerCode = 'active', resume = false }) {
  if (report.id === HMIL_WARRANTY_CLAIM_YTP_REPORT_ID) {
    return runWarrantyClaimYtpReport(page, { account, mode, report, dealerCode, resume });
  }

  return runWarrantyClaimListReport(page, { account, mode, report, dealerCode, resume });
}

export const hmilWarrantyReportDefinitions = [
  {
    id: 'hyundai-warranty-claim-list',
    name: 'Hyundai Warranty Claim List',
    sheetName: HMIL_WARRANTY_CLAIM_LIST_SHEET,
    open: openHmilWarrantyClaimList,
    readySelector: '#sClaimDateFromDate',
    dateFromSelector: '#sClaimDateFromDate',
    dateToSelector: '#sClaimDateToDate',
    exportSelector: 'a.k-grid-excel[onclick*="excelExportToKendoGrid"]'
  },
  {
    id: 'hyundai-warranty-claim-ytp',
    name: 'Hyundai Warranty Claim YTP',
    sheetName: HMIL_WARRANTY_CLAIM_YTP_SHEET,
    open: openHmilWarrantyClaim,
    readySelector: '#ro',
    activate: activateClaimYtpTab,
    dateFromSelector: '#sRoFromDate',
    dateToSelector: '#sRoToDate',
    gridId: 'gridClaimYtp',
    exportSelector: 'a.k-grid-excel[onclick*="gridClaimYtp"]'
  }
];

export async function runHmilWarrantyReport(page, options) {
  const mode = options.mode ?? 'scheduled';
  const resume = options.resume ?? (mode === 'scheduled' ? config.hmilWarrantyScheduledResume : config.hmilWarrantyResume);
  return runWarrantyReport(page, { ...options, mode, resume });
}
