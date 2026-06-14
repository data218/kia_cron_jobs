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

function gridLocator(page, gridSelector) {
  return page.locator(gridSelector || '#grid:visible, .k-grid:visible').first();
}

function pagerLocator(page, gridSelector) {
  return gridSelector
    ? page.locator(`${gridSelector} .k-pager-wrap, ${gridSelector} .k-grid-pager`).first()
    : page.locator('.k-pager-wrap:visible, .k-grid-pager:visible').first();
}

export async function getPagerState(page, pageSize, { gridSelector } = {}) {
  const pager = pagerLocator(page, gridSelector);
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
    const zeroPager = pageNumbers.length > 0 &&
      pageNumbers.every(number => number === 0) &&
      Array.from(pagerElement.querySelectorAll('.k-pager-nav')).every(element =>
        element.classList.contains('k-state-disabled') ||
        element.classList.contains('k-disabled') ||
        element.getAttribute('aria-disabled') === 'true'
      );
    const resolvedTotalItems = zeroPager ? 0 : totalItems;
    const highestVisiblePage = pageNumbers.length ? Math.max(...pageNumbers) : currentPage;
    const totalPages = resolvedTotalItems && resolvedPageSize
      ? Math.max(1, Math.ceil(resolvedTotalItems / resolvedPageSize))
      : Math.max(1, highestVisiblePage);

    return {
      totalPages,
      currentPage,
      hasPager: true,
      totalItems: resolvedTotalItems,
      pageSize: resolvedPageSize,
      requestedPageSize,
      selectedPageSize,
      visibleRangeSize
    };
  }, pageSize);
}

export async function getVisibleGridDataRowCount(page, { gridSelector } = {}) {
  const grid = gridLocator(page, gridSelector);
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

async function clickNextPage(page, { gridSelector } = {}) {
  const pager = pagerLocator(page, gridSelector);
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

function uniqueHeaders(rawHeaders) {
  const counts = new Map();
  return rawHeaders.map((header, index) => {
    const base = header || `Column ${index + 1}`;
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base} ${count}`;
  });
}

async function extractVisibleGridPage(page, { gridSelector } = {}) {
  const grid = gridLocator(page, gridSelector);
  await grid.waitFor({ state: 'visible', timeout: 10000 });

  return grid.evaluate(gridElement => {
    const headerCells = Array.from(gridElement.querySelectorAll(
      '.k-grid-header th:not(.k-hierarchy-cell), thead th:not(.k-hierarchy-cell)'
    ));
    const headers = headerCells.map(cell =>
      (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim()
    );
    const rows = Array.from(gridElement.querySelectorAll(
      '.k-grid-content tbody tr, tbody[role="rowgroup"] tr'
    )).map(row => Array.from(row.querySelectorAll('td:not(.k-hierarchy-cell)')).map(cell =>
      (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim()
    )).filter(cells => cells.length && cells.some(Boolean));

    return { headers, rows };
  });
}

export async function extractAllGridPagesFromDom(page, {
  pageSize,
  maxPages = 500,
  gridSelector
} = {}) {
  const headers = [];
  const rowValues = [];
  const initialState = await getPagerState(page, pageSize, { gridSelector });
  const totalPages = initialState.totalPages;

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (pageNumber > maxPages) {
      throw new Error(`Stopped DOM extraction after ${maxPages} pages`);
    }

    const extracted = await extractVisibleGridPage(page, { gridSelector });
    if (!headers.length) {
      headers.push(...uniqueHeaders(extracted.headers));
    }
    rowValues.push(...extracted.rows);

    if (pageNumber >= totalPages || !await clickNextPage(page, { gridSelector })) {
      break;
    }
  }

  const rows = rowValues.map(values => Object.fromEntries(
    headers.map((header, index) => [header, values[index] ?? ''])
  ));
  logger.info('Grid rows extracted directly from DOM', {
    rowCount: rows.length,
    headerCount: headers.length,
    totalPages
  });
  return { headers, rows, pageCount: totalPages };
}

export async function gridHasExplicitNoDataMessage(page, { gridSelector } = {}) {
  const grid = gridLocator(page, gridSelector);
  const visible = await grid.isVisible({ timeout: 2000 }).catch(() => false);

  if (!visible) {
    return false;
  }

  return grid.evaluate(gridElement => /no\s+records|no\s+data|no\s+items/i.test(gridElement.textContent || ''));
}

export async function gridHasNoExportableData(page, pageSize, { gridSelector, recheckIfAmbiguous = true } = {}) {
  let state = await getPagerState(page, pageSize, { gridSelector });
  let visibleRowCount = await getVisibleGridDataRowCount(page, { gridSelector });
  let hasNoDataMessage = await gridHasExplicitNoDataMessage(page, { gridSelector });

  if (
    recheckIfAmbiguous &&
    state.totalItems !== 0 &&
    visibleRowCount === 0 &&
    !hasNoDataMessage
  ) {
    await waitForKendoGridIdle(page, { timeout: 10000 });
    state = await getPagerState(page, pageSize, { gridSelector });
    visibleRowCount = await getVisibleGridDataRowCount(page, { gridSelector });
    hasNoDataMessage = await gridHasExplicitNoDataMessage(page, { gridSelector });
  }

  const noData =
    state.totalItems === 0 ||
    hasNoDataMessage ||
    (visibleRowCount === 0 && (state.totalItems == null || state.totalItems === 0));

  return {
    noData,
    totalItems: state.totalItems,
    visibleRowCount,
    hasNoDataMessage,
    totalPages: state.totalPages,
    hasPager: state.hasPager
  };
}

export async function exportCurrentGridPageToFile(page, filePath, {
  downloadTimeoutMs = 120000,
  exportSelector
} = {}) {
  const exportButton = await firstVisible(page, [
    exportSelector,
    'a.k-grid-excel[onclick*="excelExportToKendoGrid"]',
    'a.k-grid-excel',
    'a[role="button"].k-grid-excel',
    'a:has(.k-i-file-excel)'
  ].filter(Boolean), 30000);

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
  maxPages = 500,
  exportSelector,
  exportWhenEmpty = false,
  emptyDownloadTimeoutMs = 10000,
  gridSelector
}) {
  const pageFiles = [];
  const emptyCheck = await gridHasNoExportableData(page, pageSize, { gridSelector });

  logger.info('Grid pagination detected', {
    filenameBase,
    totalPages: emptyCheck.totalPages ?? 1,
    hasPager: emptyCheck.hasPager,
    totalItems: emptyCheck.totalItems,
    visibleRowCount: emptyCheck.visibleRowCount,
    hasNoDataMessage: emptyCheck.hasNoDataMessage
  });

  if (emptyCheck.noData) {
    logger.info('Grid has no data rows', {
      filenameBase,
      totalItems: emptyCheck.totalItems,
      visibleRowCount: emptyCheck.visibleRowCount,
      hasNoDataMessage: emptyCheck.hasNoDataMessage,
      exportWhenEmpty
    });

    if (exportWhenEmpty) {
      const filePath = path.join(outputDir, fileNameForPage(filenameBase, 1, 1));
      try {
        await exportCurrentGridPageToFile(page, filePath, {
          downloadTimeoutMs: emptyDownloadTimeoutMs,
          exportSelector
        });
        pageFiles.push(filePath);
      } catch (error) {
        logger.warn('Empty grid did not produce an Excel download; continuing to next report', {
          filenameBase,
          error: error.message
        });
      }
    }

    return pageFiles;
  }

  const firstState = await getPagerState(page, pageSize, { gridSelector });
  const totalPages = firstState.totalPages;

  logger.info('Grid export starting', {
    filenameBase,
    totalPages,
    currentPage: firstState.currentPage,
    totalItems: firstState.totalItems,
    pageSize: firstState.pageSize,
    requestedPageSize: firstState.requestedPageSize,
    selectedPageSize: firstState.selectedPageSize
  });

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (pageNumber > maxPages) {
      throw new Error(`Stopped export after ${maxPages} pages to avoid an infinite pagination loop`);
    }

    const filePath = path.join(outputDir, fileNameForPage(filenameBase, pageNumber, totalPages));
    await exportCurrentGridPageToFile(page, filePath, {
      downloadTimeoutMs,
      exportSelector
    });
    pageFiles.push(filePath);

    if (pageNumber >= totalPages) {
      break;
    }

    const moved = await clickNextPage(page, { gridSelector });
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
