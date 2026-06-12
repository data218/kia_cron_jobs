import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parseExcelFile } from '../excel/parse-workbook.js';
import { firstVisible } from '../playwright/browser.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { waitForKendoGridIdle } from './grid.js';

function sanitizeName(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function addHeader(headers, seenHeaders, header) {
  if (!seenHeaders.has(header)) {
    seenHeaders.add(header);
    headers.push(header);
  }
}

function normalizeRowsToHeaders(rows, headers) {
  return rows.map(row => {
    const normalized = {};
    headers.forEach(header => {
      normalized[header] = row[header] ?? '';
    });
    return normalized;
  });
}

function buildRunDir(reportId) {
  const now = new Date();
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('-');

  return path.join(config.reportChunksDir, sanitizeName(reportId), `${toIsoDate(now)}_${time}`);
}

function fileNameForPage(filenameBase, pageNumber, totalPages) {
  if (totalPages <= 1) {
    return `${filenameBase}.xlsx`;
  }

  return `${filenameBase}_page_${pageNumber}.xlsx`;
}

export async function getPagerState(page, pageSize) {
  const pager = page.locator('.k-pager-wrap:visible, .k-grid-pager:visible').first();
  const visible = await pager.isVisible({ timeout: 2000 }).catch(() => false);

  if (!visible) {
    return { totalPages: 1, currentPage: 1, hasPager: false, totalItems: null, pageSize: null };
  }

  return pager.evaluate((pagerElement, size) => {
    const toNumberOrNull = (value) => {
      const parsed = Number.parseInt(String(value ?? '').replaceAll(',', ''), 10);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const text = pagerElement.innerText || '';
    const noItems = /no\s+items|no\s+records|no\s+data/i.test(text);
    const rangeInfoMatch = text.match(/\b([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)(?:\s+items?)?\b/i);
    const infoMatch = text.match(/\bof\s+([\d,]+)(?:\s+items?)?\b/i);
    const jquery = window.jQuery || window.$;
    const gridElement = pagerElement.closest('.k-grid') || document.querySelector('#grid') || document.querySelector('.k-grid');
    const kendoGrid = jquery?.(gridElement).data('kendoGrid') || jquery?.('.k-grid').first().data('kendoGrid');
    const dataSourceTotal = typeof kendoGrid?.dataSource?.total === 'function'
      ? toNumberOrNull(kendoGrid.dataSource.total())
      : null;
    const dataSourcePageSize = typeof kendoGrid?.dataSource?.pageSize === 'function'
      ? toNumberOrNull(kendoGrid.dataSource.pageSize())
      : null;
    const totalItems = noItems
      ? 0
      : dataSourceTotal ?? toNumberOrNull(rangeInfoMatch?.[3] ?? infoMatch?.[1]);
    const requestedPageSize = toNumberOrNull(size);
    const rangeStart = toNumberOrNull(rangeInfoMatch?.[1]);
    const rangeEnd = toNumberOrNull(rangeInfoMatch?.[2]);
    const visibleRangeSize = rangeStart && rangeEnd && rangeEnd >= rangeStart
      ? rangeEnd - rangeStart + 1
      : null;
    const selectedPageSize = toNumberOrNull(
      pagerElement.querySelector('.k-pager-sizes select')?.value ||
      pagerElement.querySelector('.k-pager-sizes .k-input')?.textContent?.trim() ||
      ''
    );
    const resolvedPageSize = selectedPageSize || dataSourcePageSize || requestedPageSize || visibleRangeSize || null;
    const selected = pagerElement.querySelector('.k-pager-numbers .k-state-selected, .k-pager-numbers [aria-current="page"]');
    const currentPage = Number.parseInt(selected?.textContent?.trim() || '1', 10) || 1;
    const pageNumbers = Array.from(pagerElement.querySelectorAll('.k-pager-numbers a, .k-pager-numbers span'))
      .map(element => Number.parseInt(element.textContent?.trim() || '', 10))
      .filter(Number.isFinite);
    const highestVisiblePage = pageNumbers.length ? Math.max(...pageNumbers) : currentPage;
    const totalPages = totalItems && resolvedPageSize
      ? Math.max(1, Math.ceil(totalItems / resolvedPageSize))
      : Math.max(1, highestVisiblePage);

    return {
      totalPages,
      currentPage,
      hasPager: true,
      totalItems,
      pageSize: resolvedPageSize,
      requestedPageSize,
      selectedPageSize,
      visibleRangeSize
    };
  }, pageSize);
}

export async function getVisibleGridDataRowCount(page) {
  const grid = page.locator('#grid:visible, .k-grid:visible').first();
  const visible = await grid.isVisible({ timeout: 2000 }).catch(() => false);

  if (!visible) {
    return null;
  }

  return grid.evaluate(gridElement => {
    const rows = Array.from(gridElement.querySelectorAll([
      '.k-grid-content tbody tr',
      'tbody[role="rowgroup"] tr',
      'table tbody tr'
    ].join(',')));
    const dataRows = rows.filter(row => {
      const text = (row.textContent || '').trim();
      const hasDataCell = row.querySelector('td');
      const isNoDataRow =
        row.classList.contains('k-no-data') ||
        row.classList.contains('k-grid-norecords') ||
        /no\s+records|no\s+data|no\s+items/i.test(text);

      return hasDataCell && !isNoDataRow && text.length > 0;
    });

    return dataRows.length;
  });
}

async function clickNextPage(page) {
  const pager = page.locator('.k-pager-wrap:visible, .k-grid-pager:visible').first();
  const nextButton = pager.locator([
    'a[title*="next" i]',
    'a[aria-label*="next" i]',
    'a.k-link:has(.k-i-arrow-60-right)',
    'a.k-link:has(.k-i-arrow-e)',
    'a.k-pager-nav:has(.k-i-arrow-60-right)',
    'a.k-pager-nav:has(.k-i-arrow-e)'
  ].join(',')).last();

  await nextButton.waitFor({ state: 'visible', timeout: 15000 });

  const disabled = await nextButton.evaluate(element =>
    element.classList.contains('k-state-disabled') ||
    element.classList.contains('k-disabled') ||
    element.getAttribute('aria-disabled') === 'true'
  );

  if (disabled) {
    return false;
  }

  await nextButton.click();
  await waitForKendoGridIdle(page, { timeout: 120000 });
  return true;
}

export async function gridHasExplicitNoDataMessage(page) {
  const grid = page.locator('#grid:visible, .k-grid:visible').first();
  const visible = await grid.isVisible({ timeout: 2000 }).catch(() => false);

  if (!visible) {
    return false;
  }

  return grid.evaluate(gridElement => /no\s+records|no\s+data|no\s+items/i.test(gridElement.textContent || ''));
}

export async function exportCurrentGridPageToFile(page, filePath, { downloadTimeoutMs = 120000 } = {}) {
  const exportButton = await firstVisible(page, [
    'a.k-grid-excel[onclick*="excelExportToKendoGrid"]',
    'a.k-grid-excel',
    'a[role="button"].k-grid-excel',
    'a:has(.k-i-file-excel)'
  ], 30000);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const eventPage = typeof page.page === 'function' ? page.page() : page;
  const downloadPromise = eventPage.waitForEvent('download', { timeout: downloadTimeoutMs });
  await exportButton.click();
  const download = await downloadPromise;
  await download.saveAs(filePath);
  await download.delete().catch(() => {});

  logger.info('Grid page exported', {
    filePath,
    suggestedFilename: download.suggestedFilename()
  });

  return filePath;
}

export async function exportAllGridPagesToFiles(page, {
  outputDir,
  filenameBase,
  pageSize,
  downloadTimeoutMs = 120000,
  maxPages = 500
}) {
  const pageFiles = [];
  let firstState = await getPagerState(page, pageSize);
  let visibleRowCount = await getVisibleGridDataRowCount(page);
  let hasNoDataMessage = await gridHasExplicitNoDataMessage(page);

  if (firstState.totalItems !== 0 && visibleRowCount === 0 && !hasNoDataMessage) {
    logger.warn('Grid row count is zero without an explicit no-data state; rechecking before export decision', {
      filenameBase,
      totalItems: firstState.totalItems,
      visibleRowCount,
      hasNoDataMessage
    });

    await waitForKendoGridIdle(page, { timeout: 10000 });
    firstState = await getPagerState(page, pageSize);
    visibleRowCount = await getVisibleGridDataRowCount(page);
    hasNoDataMessage = await gridHasExplicitNoDataMessage(page);
  }

  const totalPages = firstState.totalPages;

  logger.info('Grid pagination detected', {
    filenameBase,
    totalPages,
    currentPage: firstState.currentPage,
    hasPager: firstState.hasPager,
    totalItems: firstState.totalItems,
    pageSize: firstState.pageSize,
    requestedPageSize: firstState.requestedPageSize,
    selectedPageSize: firstState.selectedPageSize,
    visibleRowCount,
    hasNoDataMessage
  });

  const shouldSkipExport =
    firstState.totalItems === 0 ||
    hasNoDataMessage ||
    (visibleRowCount === 0 && (firstState.totalItems == null || firstState.totalItems === 0));

  if (shouldSkipExport) {
    logger.info('Grid has no data rows; skipping export download', {
      filenameBase,
      totalItems: firstState.totalItems,
      visibleRowCount,
      hasNoDataMessage
    });
    return pageFiles;
  }

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (pageNumber > maxPages) {
      throw new Error(`Stopped export after ${maxPages} pages to avoid an infinite pagination loop`);
    }

    const filePath = path.join(outputDir, fileNameForPage(filenameBase, pageNumber, totalPages));
    await exportCurrentGridPageToFile(page, filePath, { downloadTimeoutMs });
    pageFiles.push(filePath);

    if (pageNumber >= totalPages) {
      break;
    }

    const moved = await clickNextPage(page);
    if (!moved) {
      logger.warn('Pager next button is disabled before expected last page', {
        pageNumber,
        totalPages
      });
      break;
    }
  }

  return pageFiles;
}

export async function mergeExcelFiles(filePaths, parseOptions = {}) {
  const headers = [];
  const seenHeaders = new Set();
  const parsedFiles = [];

  for (const filePath of filePaths) {
    const parsed = await parseExcelFile(filePath, parseOptions);
    parsed.headers.forEach(header => addHeader(headers, seenHeaders, header));
    parsedFiles.push({ filePath, parsed });

    logger.info('Excel export parsed', {
      filePath,
      workbookSheetName: parsed.workbookSheetName,
      headerCount: parsed.headers.length,
      rowCount: parsed.rows.length
    });
  }

  const rows = parsedFiles.flatMap(({ parsed }) => normalizeRowsToHeaders(parsed.rows, headers));
  return { headers, rows };
}

export async function cleanupReportExportDir(exportDir) {
  const resolvedExportDir = path.resolve(exportDir);
  const resolvedChunksRoot = path.resolve(config.reportChunksDir);

  if (!resolvedExportDir.startsWith(`${resolvedChunksRoot}${path.sep}`)) {
    throw new Error(`Refusing to delete export directory outside report chunks root: ${resolvedExportDir}`);
  }

  await fs.rm(resolvedExportDir, { recursive: true, force: true });
  logger.info('Deleted local report export files after successful Supabase upload', {
    exportDir: resolvedExportDir
  });
}

export async function exportPagedGridToSupabase(page, {
  reportId,
  sheetName,
  filenameBase,
  pageSize,
  forcedHeaders,
  outputDir = buildRunDir(reportId)
}) {
  const pageFiles = await exportAllGridPagesToFiles(page, {
    outputDir,
    filenameBase,
    pageSize
  });

  const merged = await mergeExcelFiles(pageFiles, { forcedHeaders });
  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(outputDir);

  return {
    ...dbResult,
    headerCount: merged.headers.length,
    rowCount: merged.rows.length,
    pageCount: pageFiles.length,
    outputDir,
    pageFiles
  };
}
