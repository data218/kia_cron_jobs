import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { hiibLoginSelectors as LOGIN } from '../auth/hiib-login.js';
import { parseExcelFile } from '../excel/parse-workbook.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { getReportDateOverrideRange, parseIsoLocalDate, toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { addSourceDealerCodeToDataset } from './report-metadata.js';

const SELECTORS = {
  // Sidebar: Reports/MIS -> Report -> Policy Summary Report
  reportsMisMenu: 'a[data-target="#collapsePages_4"]',
  reportsMisMenuText: 'Reports/MIS',
  reportSubMenu: 'a[data-target="#pagesCollapseAuth_12"]',
  reportSubMenuText: 'Report',
  policySummaryLink: 'a[href*="policysummaryreport" i]',

  dealerSelect: '#DealerCode',
  dateFrom: '#PolicyCreatedDate',
  dateTo: '#PolicyCreatedTo',
  searchButton: '#btnSearch',
  pageLengthSelect: 'select[name="tblAllPayout_length"]',
  // Two inputs share id="btnExportCSV" ("Export CSV" and "Download Later"),
  // so they can only be told apart by their value attribute.
  exportCsvButton: 'input[name="Submits"][value="Export CSV"]',
  grid: '#tblAllPayout',
  gridProcessing: '#tblAllPayout_processing',
  gridInfo: '#tblAllPayout_info',
  pagerNext: '#tblAllPayout_next',
  messageModal: '#PageSubmitMsg',
  messageText: '#AlertMessageContact'
};

const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

// Validate() in PolicySummary.js rejects ranges wider than DaysDiff (62) days.
const PORTAL_MAX_RANGE_DAYS = 62;
const GRID_PAGE_SIZE = '100';

/** The portal's datepicker uses format "dd/M/yyyy", e.g. 01/Jan/2026. */
export function formatDateForHiib(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = MONTH_ABBREVIATIONS[date.getMonth()];
  return `${day}/${month}/${date.getFullYear()}`;
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function buildDateChunks(startDate, endDate, chunkDays) {
  const span = Math.min(Math.max(1, chunkDays), PORTAL_MAX_RANGE_DAYS);
  const chunks = [];
  let currentStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const finalEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());

  while (currentStart <= finalEnd) {
    const candidateEnd = addDays(currentStart, span - 1);
    const cappedEnd = candidateEnd > finalEnd ? finalEnd : candidateEnd;
    chunks.push({
      startDate: currentStart,
      endDate: cappedEnd,
      startPortal: formatDateForHiib(currentStart),
      endPortal: formatDateForHiib(cappedEnd),
      startIso: toIsoDate(currentStart),
      endIso: toIsoDate(cappedEnd)
    });
    currentStart = addDays(cappedEnd, 1);
  }

  return chunks;
}

/**
 * Resolves the window to export, in priority order: an explicit range from the
 * caller, the REPORT_DATE_OVERRIDE_* env range, then the configured backfill start.
 */
export function getHyundaiInsuranceReportChunks(today = new Date(), explicitRange = null) {
  const chunkDays = config.hyundaiInsuranceReportChunkDays || 60;

  if (explicitRange?.startDate || explicitRange?.endDate) {
    const startDate = explicitRange.startDate
      ? parseIsoLocalDate(explicitRange.startDate)
      : parseIsoLocalDate(explicitRange.endDate);
    const endDate = explicitRange.endDate ? parseIsoLocalDate(explicitRange.endDate) : today;
    return buildDateChunks(startDate, endDate, chunkDays);
  }

  const overrideRange = getReportDateOverrideRange();
  if (overrideRange) {
    return buildDateChunks(overrideRange.startDate, overrideRange.endDate, chunkDays);
  }

  const startDateStr = config.hyundaiInsuranceReportBackfillStartDate;
  const startDate = startDateStr ? parseIsoLocalDate(startDateStr) : addDays(today, -365);
  return buildDateChunks(startDate, today, chunkDays);
}

function chunkFileName(chunk) {
  return `hyundai_insurance_policy_summary_${chunk.startIso.replaceAll('-', '_')}_to_${chunk.endIso.replaceAll('-', '_')}`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * The admin template can hide the side nav (sb-sidenav-toggled); reveal it so the
 * menu entries are clickable.
 */
async function ensureSidebarVisible(page) {
  const hidden = await page.evaluate(() =>
    document.body?.classList.contains('sb-sidenav-toggled') ?? false
  ).catch(() => false);

  if (!hidden) return;

  logger.info('Side navigation is collapsed; toggling it open');
  await page.locator('#sidebarToggle').first().click({ force: true }).catch(() => {});
  await sleep(700);
}

/**
 * Expands one collapsible sidebar entry and waits for its target panel to open.
 * `targetId` is the Bootstrap collapse it controls (e.g. "#collapsePages_4").
 */
/**
 * Expands one collapsible sidebar entry and waits for its target panel to open.
 * `root` scopes the search to the parent panel, which matters because several nav
 * links share text (e.g. "Reports/MIS" also contains "Report").
 */
async function expandSidebarEntry(page, root, selector, targetId, label) {
  await ensureSidebarVisible(page);

  const link = root.locator(selector).first();

  // isVisible() does not wait, so wait explicitly before deciding it is missing.
  try {
    await link.waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    throw new Error(`Sidebar entry "${label}" never became visible (${selector})`);
  }

  const alreadyOpen = await page.evaluate(id =>
    document.querySelector(id)?.classList.contains('show') ?? false, targetId
  ).catch(() => false);

  if (alreadyOpen) {
    logger.info('Sidebar entry already expanded', { label });
    return true;
  }

  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.click({ force: true });

  // Wait for the Bootstrap collapse to finish opening.
  await page.waitForFunction(id =>
    document.querySelector(id)?.classList.contains('show') ?? false,
  targetId, { timeout: 15000 }).catch(() => {
    logger.warn('Sidebar collapse did not report as open; continuing', { label, targetId });
  });

  await sleep(400);
  logger.info('Sidebar entry expanded', { label });
  return true;
}

/**
 * Walks the sidebar: Reports/MIS -> Report -> Policy Summary Report.
 * Falls back to the direct URL if the menu is not laid out as expected.
 */
export async function openPolicySummaryReport(page, account = null) {
  if (page.isClosed()) throw new Error('Page is closed');

  await page.goto(config.hiibPolicySummaryReportUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // isVisible() returns immediately, so wait properly before deciding the session died.
  const isVisible = await page.locator(SELECTORS.dateFrom).first()
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  if (!isVisible || page.url().toLowerCase().includes('login')) {
    logger.warn('HIIB session expired or date field missing; re-submitting login credentials');
    await page.goto(config.hiibLoginUrl, { waitUntil: 'domcontentloaded' });
    await page.locator(LOGIN.userId).first().waitFor({ state: 'visible', timeout: 30000 });

    await page.fill(LOGIN.userId, account?.userId ?? config.hiibUserId);
    await page.fill(LOGIN.password, account?.password ?? config.hiibPassword);

    // The portal validates the captcha client-side against this hidden field.
    const answer = await page.evaluate(() => document.getElementById('hdnCaptcha')?.value ?? '');
    if (answer) {
      await page.fill(LOGIN.captchaInput, answer);
    }

    await page.click(LOGIN.loginButton);
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await sleep(1500);

    // Surface a rejected login instead of failing every later chunk with a
    // confusing "date field not found".
    const message = await readVisibleMessage(page);
    if (message) {
      throw new Error(`HIIB re-login was rejected: ${message}`);
    }

    logger.info('HIIB re-login completed', { url: page.url() });
    await page.goto(config.hiibPolicySummaryReportUrl, { waitUntil: 'domcontentloaded' });
  }

  await page.locator(SELECTORS.dateFrom).first().waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  logger.info('Policy Summary Report page ready', { url: page.url() });
}




// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

/**
 * The date inputs strip non-digits on keyup, so the value is set directly and the
 * change event is raised for the datepicker instead of typing into the field.
 */
async function setDateField(page, selector, value) {
  await page.evaluate(({ sel, val }) => {
    const element = document.querySelector(sel);
    if (!element) throw new Error(`Date field not found: ${sel}`);
    element.value = val;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });

  const applied = await page.inputValue(selector).catch(() => '');
  if (applied.trim() !== value) {
    throw new Error(`Date field ${selector} did not retain "${value}" (got "${applied}")`);
  }
}

async function readVisibleMessage(page) {
  const visible = await page.locator(SELECTORS.messageModal).first()
    .isVisible({ timeout: 300 }).catch(() => false);
  if (!visible) return '';
  return (await page.locator(SELECTORS.messageText).first().innerText().catch(() => '')).trim();
}

async function waitForGridIdle(page, timeout = 180000) {
  await page.waitForFunction(() => {
    const processing = document.getElementById('tblAllPayout_processing');
    if (!processing) return true;
    const style = window.getComputedStyle(processing);
    return style.display === 'none' || style.visibility === 'hidden';
  }, undefined, { timeout }).catch(() => {
    logger.warn('Grid processing indicator did not clear within the timeout');
  });
}

/** Reads DataTables' own "Showing X to Y of Z entries" summary. */
async function readGridInfo(page) {
  const text = await page.locator(SELECTORS.gridInfo).first().innerText().catch(() => '');
  const match = text.replace(/,/g, '').match(/of\s+(\d+)\s+entries/i);
  return {
    text: text.trim(),
    totalRows: match ? Number(match[1]) : null
  };
}

async function runSearch(page, chunk) {
  await setDateField(page, SELECTORS.dateFrom, chunk.startPortal);
  await setDateField(page, SELECTORS.dateTo, chunk.endPortal);

  logger.info('Searching Policy Summary Report', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal
  });

  await page.click(SELECTORS.searchButton);
  await sleep(1500);
  await waitForGridIdle(page);

  const message = await readVisibleMessage(page);
  if (message) {
    throw new Error(`Portal rejected the search: ${message}`);
  }

  const postSearchDelay = config.hyundaiInsuranceReportPostSearchDelayMs || 5000;
  if (postSearchDelay > 0) await sleep(postSearchDelay);

  const info = await readGridInfo(page);
  logger.info('Search finished', { gridInfo: info.text || '(none)', totalRows: info.totalRows });
  return info;
}

async function setPageLengthTo100(page) {
  const select = page.locator(SELECTORS.pageLengthSelect).first();
  if (!(await select.isVisible({ timeout: 10000 }).catch(() => false))) {
    logger.warn('Page length selector not found; leaving the default page size');
    return false;
  }

  await select.selectOption(GRID_PAGE_SIZE).catch(async () => {
    await page.evaluate(({ sel, size }) => {
      const element = document.querySelector(sel);
      element.value = size;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel: SELECTORS.pageLengthSelect, size: GRID_PAGE_SIZE });
  });

  await sleep(1200);
  await waitForGridIdle(page);
  logger.info('Grid page length set', { pageSize: GRID_PAGE_SIZE });
  return true;
}

// ---------------------------------------------------------------------------
// Grid scraping (fallback when the CSV export returns nothing)
// ---------------------------------------------------------------------------

async function readGridPage(page) {
  return page.evaluate(() => {
    const table = document.getElementById('tblAllPayout');
    if (!table) return { headers: [], rows: [] };

    const headers = Array.from(table.querySelectorAll('thead th'))
      .map(cell => (cell.innerText || '').trim());

    const rows = Array.from(table.querySelectorAll('tbody tr'))
      .map(tr => Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim()))
      .filter(cells => cells.length && cells.some(cell => cell !== ''));

    return { headers, rows };
  });
}

/**
 * Walks every page of the DataTables grid. The page count is dynamic, so this
 * follows the Next button until it is disabled rather than assuming a count.
 */
async function scrapeAllGridPages(page, expectedTotalRows) {
  const collected = [];
  let headers = [];
  let pageIndex = 0;
  const maxPages = 500;

  while (pageIndex < maxPages) {
    await waitForGridIdle(page);
    const snapshot = await readGridPage(page);

    if (snapshot.headers.length && !headers.length) {
      headers = snapshot.headers;
    }

    if (!snapshot.rows.length) {
      logger.info('Grid page had no rows; stopping pagination', { pageIndex: pageIndex + 1 });
      break;
    }

    collected.push(...snapshot.rows);
    pageIndex += 1;
    logger.info('Scraped grid page', {
      page: pageIndex,
      rowsOnPage: snapshot.rows.length,
      rowsCollected: collected.length,
      expectedTotalRows: expectedTotalRows ?? '(unknown)'
    });

    const nextState = await page.evaluate(() => {
      const next = document.getElementById('tblAllPayout_next');
      if (!next) return { present: false, disabled: true };
      return { present: true, disabled: next.classList.contains('disabled') };
    });

    if (!nextState.present || nextState.disabled) {
      logger.info('Reached the last grid page', { totalPages: pageIndex });
      break;
    }

    const firstCellBefore = snapshot.rows[0]?.join('|') ?? '';
    await page.locator(`${SELECTORS.pagerNext} a`).first().click({ force: true }).catch(() => {});

    // Wait until the first row actually changes, so we never read the same page twice.
    await page.waitForFunction(previous => {
      const table = document.getElementById('tblAllPayout');
      const firstRow = table?.querySelector('tbody tr');
      if (!firstRow) return false;
      const current = Array.from(firstRow.querySelectorAll('td'))
        .map(td => (td.innerText || '').trim()).join('|');
      return current !== previous;
    }, firstCellBefore, { timeout: 60000 }).catch(() => {
      logger.warn('Grid page did not change after clicking Next', { page: pageIndex });
    });
  }

  if (expectedTotalRows && collected.length !== expectedTotalRows) {
    logger.warn('Scraped row count does not match the grid total', {
      scraped: collected.length,
      expected: expectedTotalRows
    });
  }

  return { headers, rows: collected };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Minimal RFC4180 parser. Everything stays a string so nothing gets coerced. */
export function parseCsv(text) {
  const content = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Handled by the \n branch.
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(entry => entry.some(cell => String(cell ?? '').trim() !== ''));
}

/**
 * The portal prefixes text-forced fields (Policy No, Cheque No) with an apostrophe
 * so Excel keeps them as text. It is an export artifact, not part of the value.
 */
function normalizeCell(value) {
  const text = String(value ?? '').trim();
  return text.startsWith("'") ? text.slice(1).trim() : text;
}

function datasetFromMatrix(headerRow, dataRows) {
  const headers = headerRow.map(header => String(header ?? '').trim()).filter(Boolean);
  const rows = dataRows.map(entry => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = normalizeCell(entry[index]);
    });
    return record;
  });

  return { headers, rows };
}

async function parseExportFile(filePath) {
  if (/\.xlsx?$/i.test(filePath)) {
    const parsed = await parseExcelFile(filePath);
    return { headers: parsed.headers, rows: parsed.rows };
  }

  const matrix = parseCsv(await fs.readFile(filePath, 'utf8'));
  if (!matrix.length) return { headers: [], rows: [] };
  return datasetFromMatrix(matrix[0], matrix.slice(1));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Submits the export form and captures the returned file. The portal answers a
 * valid request with a file download; large ranges can return nothing at all,
 * in which case the caller falls back to scraping the grid.
 */
async function exportChunkToFile(page, chunk, outputDir) {
  const downloadPromise = page.waitForEvent('download', {
    timeout: config.hyundaiInsuranceReportDownloadTimeoutMs
  }).catch(() => null);

  logger.info('Clicking Export CSV', { startDate: chunk.startPortal, endDate: chunk.endPortal });
  await page.click(SELECTORS.exportCsvButton);

  const download = await downloadPromise;
  if (!download) {
    const message = await readVisibleMessage(page);
    logger.warn('Export CSV returned no file for this range', {
      startDate: chunk.startPortal,
      endDate: chunk.endPortal,
      portalMessage: message || '(none)'
    });
    return null;
  }

  const suggested = download.suggestedFilename() || 'export.csv';
  const extension = path.extname(suggested) || '.csv';
  const targetPath = path.join(outputDir, `${chunkFileName(chunk)}${extension}`);

  await fs.mkdir(outputDir, { recursive: true });
  await download.saveAs(targetPath);

  const { size } = await fs.stat(targetPath);
  logger.info('Export downloaded', {
    startDate: chunk.startPortal,
    endDate: chunk.endPortal,
    file: path.basename(targetPath),
    bytes: size
  });

  return targetPath;
}

// ---------------------------------------------------------------------------
// Dealer
// ---------------------------------------------------------------------------

async function resolveDealerCode(page, requestedDealerCode) {
  if (requestedDealerCode) return String(requestedDealerCode).toUpperCase();
  if (config.hiibDealerCode) return String(config.hiibDealerCode).toUpperCase();

  const label = await page.evaluate(sel => {
    const select = document.querySelector(sel);
    if (!select) return '';
    return select.options[select.selectedIndex]?.text ?? '';
  }, SELECTORS.dealerSelect).catch(() => '');

  const match = String(label).match(/^\s*([A-Z0-9]+)\s*-/i);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

async function selectDealerIfPossible(page, dealerCode) {
  const state = await page.evaluate(sel => {
    const select = document.querySelector(sel);
    if (!select) return { present: false };
    return {
      present: true,
      disabled: select.disabled,
      selectedText: select.options[select.selectedIndex]?.text ?? ''
    };
  }, SELECTORS.dealerSelect).catch(() => ({ present: false }));

  if (!state.present) return;

  if (state.disabled) {
    logger.info('Dealer dropdown is locked to this login', { dealer: state.selectedText });
    return;
  }

  if (!dealerCode) return;

  const selected = await page.evaluate(({ sel, code }) => {
    const select = document.querySelector(sel);
    const option = Array.from(select.options).find(item =>
      item.text.toUpperCase().startsWith(`${code.toUpperCase()}-`)
    );
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { sel: SELECTORS.dealerSelect, code: dealerCode }).catch(() => false);

  logger.info('Dealer selection attempted', { dealerCode, selected });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Runs the HIIB Policy Summary Report end to end for the configured window and
 * saves the result to Supabase. `page` must belong to a logged-in HIIB session.
 */
export async function downloadHyundaiInsuranceReport(page, {
  dealerCode = null,
  account = null,
  startDate = null,
  endDate = null,
  // The portal caps CSV exports at ~3 per day, so rows are read straight out of
  // the DataTables grid. The grid carries the same ~79 columns as the export.
  useCsvExport = config.hyundaiInsuranceReportUseCsvExport
} = {}) {
  const forceGridScrape = !useCsvExport;
  // Each portal login writes to its own table (Hyundai N5203 vs Platinum N5211).
  const sheetName = account?.sheetName || config.hyundaiInsuranceReportSheetName;

  logger.info('HIIB Policy Summary Report started', {
    account: account?.id ?? 'hiib',
    sheetName,
    source: useCsvExport ? 'csv-export' : 'dom-grid'
  });

  await openPolicySummaryReport(page, account);

  const resolvedDealerCode = await resolveDealerCode(page, dealerCode);
  await selectDealerIfPossible(page, dealerCode);

  const today = new Date();
  const chunks = getHyundaiInsuranceReportChunks(today, { startDate, endDate });
  const runDate = toIsoDate(today);
  const reportChunksDir = account?.reportChunksDir || config.hiibReportChunksDir;
  const chunkDir = path.join(reportChunksDir, 'hyundai-insurance-report', resolvedDealerCode, runDate);
  await fs.mkdir(chunkDir, { recursive: true });

  logger.info('Date chunks prepared', {
    dealerCode: resolvedDealerCode,
    startDate: chunks[0]?.startPortal,
    endDate: chunks[chunks.length - 1]?.endPortal,
    chunkCount: chunks.length,
    chunkDays: config.hyundaiInsuranceReportChunkDays,
    chunkDir
  });

  let exportedFileCount = 0;
  let scrapedChunkCount = 0;
  let emptyChunkCount = 0;
  let savedRowCount = 0;
  let insertedRowCount = 0;
  const failedChunks = [];

  /** Saved per chunk so a long backfill never loses completed work to a later failure. */
  const saveChunk = async (dataset, chunk) => {
    if (!dataset.rows.length) return;

    const enriched = addSourceDealerCodeToDataset(dataset, resolvedDealerCode);
    const dbResult = await saveReportSheetToSupabase({
      brand: 'hyundai',
      sheetName,
      headers: enriched.headers,
      rows: enriched.rows
    });

    savedRowCount += enriched.rows.length;
    insertedRowCount += dbResult.relationalResult?.insertedRowCount ?? dbResult.addedRowCount ?? 0;

    logger.info('Chunk saved to Supabase', {
      startDate: chunk.startPortal,
      endDate: chunk.endPortal,
      rowCount: enriched.rows.length,
      inserted: dbResult.relationalResult?.insertedRowCount,
      duplicates: dbResult.relationalResult?.duplicateRowCount,
      runningTotal: savedRowCount
    });
  };

  /** Returns the form to a freshly-searched state with the 100-row page size applied. */
  const reopenAndSearch = async chunk => {
    await openPolicySummaryReport(page, account);
    await selectDealerIfPossible(page, dealerCode);
    const info = await runSearch(page, chunk);
    await setPageLengthTo100(page);
    return info;
  };

  const processChunk = async (chunk, index) => {
    const info = await runSearch(page, chunk);

    if (info.totalRows === 0) {
      logger.info('No records for this range; skipping', {
        startDate: chunk.startPortal,
        endDate: chunk.endPortal
      });
      emptyChunkCount += 1;
      return;
    }

    await setPageLengthTo100(page);

    // Opt-in only: the portal allows ~3 CSV exports per day, and the grid exposes
    // the same columns, so this is skipped unless useCsvExport was requested.
    let filePath = null;
    const exportAttempts = forceGridScrape ? 0 : Math.max(1, config.hyundaiInsuranceReportExportAttempts);

    for (let attempt = 1; attempt <= exportAttempts && !filePath; attempt += 1) {
      if (attempt > 1) {
        logger.info('Retrying Export CSV', { attempt, of: exportAttempts });
        await reopenAndSearch(chunk);
      }
      filePath = await exportChunkToFile(page, chunk, chunkDir);
    }

    if (filePath) {
      const dataset = await parseExportFile(filePath).catch(error => {
        logger.warn('Could not parse the export file', { filePath, error: error.message });
        return { headers: [], rows: [] };
      });

      logger.info('Export parsed', {
        file: path.basename(filePath),
        headerCount: dataset.headers.length,
        rowCount: dataset.rows.length
      });

      if (dataset.rows.length) {
        exportedFileCount += 1;
        await saveChunk(dataset, chunk);
      }
      return;
    }

    // Walk the paginated grid instead. When an export was attempted first, its
    // POST leaves the form dirty, so the search is re-run before scraping.
    logger.info('Using paginated grid scraping for this chunk', { forced: forceGridScrape });

    let gridInfo = info;
    if (!forceGridScrape) {
      gridInfo = await reopenAndSearch(chunk);
    }

    const scraped = await scrapeAllGridPages(page, gridInfo.totalRows);
    if (scraped.rows.length) {
      scrapedChunkCount += 1;
      await saveChunk(datasetFromMatrix(scraped.headers, scraped.rows), chunk);
    }
  };

  for (const [index, chunk] of chunks.entries()) {
    logger.info('===== Processing chunk =====', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal,
      rowsSavedSoFar: savedRowCount
    });

    try {
      await processChunk(chunk, index);
    } catch (error) {
      // A dead browser cannot be recovered by moving to the next window - every
      // remaining chunk would "fail" instantly and hide the real cause.
      const browserGone = page.isClosed?.() ||
        /Target page, context or browser has been closed|Target closed|browser has been closed/i
          .test(error.message);

      if (browserGone) {
        logger.error('Browser/session was closed; aborting the run', {
          chunk: `${index + 1}/${chunks.length}`,
          startDate: chunk.startPortal,
          endDate: chunk.endPortal,
          rowsSavedSoFar: savedRowCount,
          error: error.message
        });
        throw new Error(
          `HIIB browser closed during chunk ${index + 1}/${chunks.length} ` +
          `(${chunk.startIso}..${chunk.endIso}) after saving ${savedRowCount} rows. ` +
          'Re-run from that date. Use --headless so the window cannot be closed by hand.'
        );
      }

      // One bad window must not abandon the rest of a multi-year backfill.
      failedChunks.push({
        startDate: chunk.startPortal,
        endDate: chunk.endPortal,
        startIso: chunk.startIso,
        endIso: chunk.endIso,
        error: error.message
      });
      logger.error('Chunk failed; continuing with the next one', {
        chunk: `${index + 1}/${chunks.length}`,
        startDate: chunk.startPortal,
        endDate: chunk.endPortal,
        error: error.message
      });
    }

    // Reset the form for the next chunk.
    if (index < chunks.length - 1) {
      try {
        await openPolicySummaryReport(page, account);
        await selectDealerIfPossible(page, dealerCode);
      } catch (error) {
        logger.error('Could not reopen the report page', { error: error.message });
      }
      const betweenDelay = config.hyundaiInsuranceReportBetweenChunksDelayMs || 4000;
      if (betweenDelay > 0) await sleep(betweenDelay);
    }
  }

  if (failedChunks.length) {
    logger.warn('Some chunks failed and were skipped', {
      failedChunkCount: failedChunks.length,
      failedChunks: failedChunks.map(entry => `${entry.startIso}..${entry.endIso}`)
    });
  }

  return {
    name: 'Hyundai Insurance Policy Summary Report',
    id: 'hyundai-insurance-report',
    sheetName,
    dealerCode: resolvedDealerCode,
    rowCount: savedRowCount,
    insertedRowCount,
    chunkCount: chunks.length,
    exportedFileCount,
    scrapedChunkCount,
    emptyChunkCount,
    failedChunkCount: failedChunks.length,
    failedChunks
  };
}

export { SELECTORS as hyundaiInsuranceReportSelectors };
