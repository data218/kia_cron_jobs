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

async function getPagerState(page, pageSize) {
  const pager = page.locator('.k-pager-wrap:visible, .k-grid-pager:visible').first();
  const visible = await pager.isVisible({ timeout: 2000 }).catch(() => false);

  if (!visible) {
    return { totalPages: 1, currentPage: 1, hasPager: false };
  }

  return pager.evaluate((pagerElement, size) => {
    const text = pagerElement.innerText || '';
    const infoMatch = text.match(/\bof\s+([\d,]+)\s+items?\b/i);
    const totalItems = infoMatch ? Number.parseInt(infoMatch[1].replaceAll(',', ''), 10) : null;
    const pageSize = Number.parseInt(size, 10) || null;
    const selected = pagerElement.querySelector('.k-pager-numbers .k-state-selected, .k-pager-numbers [aria-current="page"]');
    const currentPage = Number.parseInt(selected?.textContent?.trim() || '1', 10) || 1;
    const pageNumbers = Array.from(pagerElement.querySelectorAll('.k-pager-numbers a, .k-pager-numbers span'))
      .map(element => Number.parseInt(element.textContent?.trim() || '', 10))
      .filter(Number.isFinite);
    const highestVisiblePage = pageNumbers.length ? Math.max(...pageNumbers) : currentPage;
    const totalPages = totalItems && pageSize
      ? Math.max(1, Math.ceil(totalItems / pageSize))
      : Math.max(1, highestVisiblePage);

    return {
      totalPages,
      currentPage,
      hasPager: true
    };
  }, pageSize);
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

export async function exportCurrentGridPageToFile(page, filePath) {
  const exportButton = await firstVisible(page, [
    'a.k-grid-excel[onclick*="excelExportToKendoGrid"]',
    'a.k-grid-excel',
    'a[role="button"].k-grid-excel',
    'a:has(.k-i-file-excel)'
  ], 30000);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const eventPage = typeof page.page === 'function' ? page.page() : page;
  const downloadPromise = eventPage.waitForEvent('download', { timeout: 120000 });
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
  maxPages = 500
}) {
  const pageFiles = [];
  const firstState = await getPagerState(page, pageSize);
  const totalPages = firstState.totalPages;

  logger.info('Grid pagination detected', {
    filenameBase,
    totalPages,
    currentPage: firstState.currentPage,
    hasPager: firstState.hasPager
  });

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (pageNumber > maxPages) {
      throw new Error(`Stopped export after ${maxPages} pages to avoid an infinite pagination loop`);
    }

    const filePath = path.join(outputDir, fileNameForPage(filenameBase, pageNumber, totalPages));
    await exportCurrentGridPageToFile(page, filePath);
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
