import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { saveSessionStateToPath, firstVisible } from '../playwright/browser.js';
import { saveReportSheetToSupabaseRest } from '../supabase/relational-store.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { cleanupReportExportDir, mergeExcelFiles } from './paged-export.js';

const LOGIN_URL = config.kiaSafetyLoginUrl;
const SESSION_PATH = config.kiaSafetySessionStatePath;
const SHEET_NAME = config.kiaSafetySheetName;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDatePortal(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = MONTH_NAMES[date.getMonth()];
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(label, multiplier = 1) {
  const min = 200;
  const max = 500;
  const delayMs = Math.round(randomInt(min, max) * multiplier);
  if (delayMs <= 0) return;
  logger.info('Human pause', { label, delayMs });
  await sleep(delayMs);
}

async function humanFill(locator, value, label) {
  await locator.click();
  await humanPause(`${label} focus`, 0.3);
  await locator.fill('');
  for (const char of String(value)) {
    await locator.type(char, { delay: randomInt(30, 80) });
  }
  await humanPause(`${label} typed`, 0.2);
}

function monthChunks(fromDate, toDate) {
  const chunks = [];
  
  if (fromDate.getTime() === toDate.getTime()) {
    chunks.push({
      label: `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, '0')}-${String(fromDate.getDate()).padStart(2, '0')}`,
      startDate: fromDate,
      endDate: toDate,
      startPortal: formatDatePortal(fromDate),
      endPortal: formatDatePortal(toDate)
    });
    return chunks;
  }

  let current = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);

  while (current <= toDate) {
    const monthStart = new Date(current.getFullYear(), current.getMonth(), 1);
    const monthEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0);

    const chunkStart = monthStart < fromDate ? fromDate : monthStart;
    const chunkEnd = monthEnd > toDate ? toDate : monthEnd;

    chunks.push({
      label: `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`,
      startDate: chunkStart,
      endDate: chunkEnd,
      startPortal: formatDatePortal(chunkStart),
      endPortal: formatDatePortal(chunkEnd)
    });

    current.setMonth(current.getMonth() + 1);
  }

  return chunks;
}

function buildRunDir() {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
  return path.join(config.reportChunksDir, 'kia-safety', `${now.toISOString().slice(0, 10)}_${time}`);
}

const POLICY_SUMMARY_URL = config.kiaSafetyUrl;

async function loginToKiaSafety(page) {
  logger.info('Opening Kia Safety login page', { url: LOGIN_URL });

  await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: config.loginTimeoutMs
  });
  await humanPause('page load');

  const usernameInput = await firstVisible(page, [
    '#txtUserName',
    'input[name="txtUserName"]',
    'input[id*="User" i]',
    'input[type="text"]'
  ], 15000);

  await humanFill(usernameInput, config.kiaSafetyUserId, 'username');

  const passwordInput = await firstVisible(page, [
    '#txtPassword',
    'input[name="txtPassword"]',
    'input[id*="pass" i]',
    'input[type="password"]'
  ], 10000);

  await humanFill(passwordInput, config.kiaSafetyPassword, 'password');
  await humanPause('before login click', 1.5);

  const loginButton = await firstVisible(page, [
    '#btnLogin',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign In")',
    'input[value*="Sign" i]'
  ], 10000);

  await loginButton.click();
  await humanPause('after login submit', 3);
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

  await saveSessionStateToPath(page.context(), SESSION_PATH);
  logger.info('Kia Safety login completed');
}

async function ensureOnPolicyReportPage(page) {
  const currentUrl = page.url();
  if (currentUrl.includes('VSPolicy_SummaryReport.aspx')) {
    logger.info('Already on Policy Summary page');
    return;
  }

  if (currentUrl.includes('Login.aspx') || currentUrl.includes('Welcome')) {
    logger.info('Navigating directly to Policy Summary URL');
    await page.goto(POLICY_SUMMARY_URL, {
      waitUntil: 'domcontentloaded',
      timeout: config.loginTimeoutMs
    });
    await humanPause('policy summary page load', 2);

    if (page.url().includes('Login.aspx')) {
      logger.info('Session expired, re-logging in');
      await loginToKiaSafety(page);
      await page.goto(POLICY_SUMMARY_URL, {
        waitUntil: 'domcontentloaded',
        timeout: config.loginTimeoutMs
      });
      await humanPause('policy summary page load', 2);
    }
    return;
  }

  logger.info('Navigating via menu to Policy Summary');

  const reportTab = await firstVisible(page, [
    'a:has-text("Report")',
    'span:has-text("Report")',
    'a[id*="Report" i]',
    'a[href*="report" i]'
  ], 15000);

  await humanPause('before report tab click', 1);
  await reportTab.click();
  await humanPause('after report tab click', 2);

  const policySummary = await firstVisible(page, [
    'a:has-text("Policy Summary")',
    'a:has-text("Policy Summary Report")',
    'a[id*="PolicySummary" i]',
    'a[href*="PolicySummary" i]'
  ], 15000);

  await humanPause('before policy summary click', 1);
  await policySummary.click();
  await humanPause('after policy summary click', 3);

  const afterUrl = page.url();
  logger.info('Navigated to Policy Summary', { url: afterUrl });
}

async function setDateDirectly(page, dateInputId, date) {
  const value = formatDatePortal(date);
  const selector = `#${dateInputId}`;
  await page.locator(selector).waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    if (el) {
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { sel: selector, val: value });
}

async function fillDateRangeAndGo(page, chunk) {
  const fromPortal = formatDatePortal(chunk.startDate);
  const toPortal = formatDatePortal(chunk.endDate);
  logger.info('Setting date range directly', { from: fromPortal, to: toPortal });

  await setDateDirectly(page, 'ContentPlaceHolder1_txtFromDate', chunk.startDate);
  await setDateDirectly(page, 'ContentPlaceHolder1_txtToDate', chunk.endDate);
  await sleep(500);

  const goButton = page.locator('#ContentPlaceHolder1_btnSearch').first();

  const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
  logger.info('Clicking Go button');
  await goButton.click();

  const popup = await popupPromise;
  if (popup) {
    logger.info('Popup detected after Go click', { url: popup.url() });
    await popup.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    return { downloadPath: null, popupPage: popup };
  }

  logger.info('No popup detected, navigating directly to popup URL');
  const popupUrl = `https://www.kiasafety.com/VISOF/Report/VSPolicy_SummaryReportList.aspx?dtefrm=${encodeURIComponent(fromPortal)}&dteto=${encodeURIComponent(toPortal)}&zoneid=0&stateid=0&cityid=0&productid=0&OEMType=1&DealerGroupCode=0`;
  const popupPage = await page.context().newPage();
  await popupPage.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await popupPage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await sleep(3000);
  return { downloadPath: null, popupPage };
}

async function extractGridData(page, popupPage) {
  const targetPage = popupPage || page;
  logger.info('Extracting data directly from grid table');

  await sleep(2000);

  let grid = null;

  const gridSelectors = [
    'table:has(th)',
    'table[id*="gvPolicy"]',
    'table[id*="GridView"]',
    'table[id*="gvData"]',
    'table[id*="ContentPlaceHolder1_"]',
    'table[id*="gv"]',
    'table[class*="grid"]',
    'table[class*="GridView"]',
    '#ContentPlaceHolder1_gvPolicy',
    '#ContentPlaceHolder1_GridView1',
    '#ContentPlaceHolder1_gvData',
    'table[id*="Policy"]',
  ];

  for (const selector of gridSelectors) {
    const elements = await targetPage.locator(selector).count().catch(() => 0);
    if (elements > 0) {
      for (let i = 0; i < elements; i++) {
        const el = targetPage.locator(selector).nth(i);
        const isVisible = await el.isVisible({ timeout: 500 }).catch(() => false);
        if (isVisible) {
          const text = await el.textContent().catch(() => '');
          if (!text.toLowerCase().includes('request is being processed') && !text.toLowerCase().includes('please wait')) {
            const rows = await el.locator('tbody tr').count().catch(() => 0);
            if (rows > 0) {
              grid = el;
              logger.info('Found grid table', { selector, index: i, rowCount: rows });
              break;
            }
          }
        }
      }
      if (grid) break;
    }
  }

  if (!grid) {
    const tables = await targetPage.locator('table').all();
    for (const el of tables) {
      const isVisible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!isVisible) continue;

      const text = await el.textContent().catch(() => '');
      if (text.toLowerCase().includes('request is being processed') || text.toLowerCase().includes('please wait')) {
        continue;
      }

      const hasNestedTable = await el.locator('table').count().then(c => c > 0).catch(() => false);
      if (hasNestedTable) continue;

      const headerCells = await el.locator('tr').first().locator('th, td').count().catch(() => 0);
      if (headerCells < 3) continue;
      const rows = await el.locator('tbody tr').count().catch(() => 0);
      if (rows > 0) {
        const firstRowText = await el.locator('tbody tr').first().textContent().catch(() => '');
        if (firstRowText && firstRowText.trim().length > 5 && !firstRowText.toLowerCase().includes('please wait')) {
          grid = el;
          logger.info('Found grid table (fallback)', { rowCount: rows, colCount: headerCells });
          break;
        }
      }
    }
  }

  if (!grid) {
    const html = await targetPage.content();
    const debugPath = path.join(config.reportChunksDir, 'kia-safety', 'main_debug.html');
    await fs.mkdir(path.dirname(debugPath), { recursive: true });
    await fs.writeFile(debugPath, html, 'utf-8');
    logger.info('Saved main page HTML', { size: html.length });
  }

  if (!grid) {
    const tables = await targetPage.locator('table').all();
    const candidates = [];
    for (const el of tables) {
      const isVisible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!isVisible) continue;
      const hasNested = await el.locator('table').count().then(c => c > 0).catch(() => false);
      if (hasNested) continue;
      const cols = await el.locator('tr').first().locator('th, td').count().catch(() => 0);
      if (cols < 3) continue;
      const rows = await el.locator('tr').count().catch(() => 0);
      if (rows < 2) continue;
      const text = await el.textContent().catch(() => '');
      if (text.toLowerCase().includes('request is being processed') || text.toLowerCase().includes('please wait')) continue;
      candidates.push({ el, cols, rows });
    }
    candidates.sort((a, b) => b.cols - a.cols);
    if (candidates.length > 0) {
      grid = candidates[0].el;
      logger.info('Found grid table (best candidate)', candidates[0]);
    }
  }

  if (!grid) {
    await sleep(5000);
    const tables = await targetPage.locator('table').all();
    const candidates = [];
    for (const el of tables) {
      const isVisible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!isVisible) continue;
      const hasNested = await el.locator('table').count().then(c => c > 0).catch(() => false);
      if (hasNested) continue;
      const cols = await el.locator('tr').first().locator('th, td').count().catch(() => 0);
      if (cols < 3) continue;
      const rows = await el.locator('tr').count().catch(() => 0);
      if (rows < 2) continue;
      const text = await el.textContent().catch(() => '');
      if (text.toLowerCase().includes('request is being processed') || text.toLowerCase().includes('please wait')) continue;
      candidates.push({ el, cols, rows });
    }
    candidates.sort((a, b) => b.cols - a.cols);
    if (candidates.length > 0) {
      grid = candidates[0].el;
      logger.info('Found grid table (retry best candidate)', candidates[0]);
    }
  }

  if (!grid) {
    const pageContent = await targetPage.content();
    logger.error('Page content for debugging', { content: pageContent.substring(0, 5000) });
    throw new Error('No grid table found on page');
  }

  await waitForGridDataLoad(page, grid);

  const headers = [];
  const headerCells = await grid.locator('thead tr th, thead tr td').all();
  if (headerCells.length === 0) {
    const firstRowCells = await grid.locator('tbody tr').first().locator('td, th').all();
    for (const cell of firstRowCells) {
      headers.push(await cell.textContent().then(t => t?.trim() || ''));
    }
  } else {
    for (const cell of headerCells) {
      headers.push(await cell.textContent().then(t => t?.trim() || ''));
    }
  }

  const rows = [];
  const dataRows = await grid.locator('tbody tr').all();
  for (const row of dataRows) {
    const cells = await row.locator('td').all();
    if (cells.length === 0) continue;

    const rowData = {};
    for (let i = 0; i < cells.length; i++) {
      const header = headers[i] || `col_${i}`;
      rowData[header] = await cells[i].textContent().then(t => t?.trim() || '');
    }
    rows.push(rowData);
  }

  logger.info('Grid data extracted', { 
    headerCount: headers.length, 
    rowCount: rows.length,
    headers: headers.slice(0, 10)
  });

  return { headers, rows };
}

async function waitForGridDataLoad(page, grid, maxWaitMs = 120000) {
  const startTime = Date.now();
  const loadingTexts = ['Request is being processed', 'please wait', 'loading', 'Processing...'];

  while (Date.now() - startTime < maxWaitMs) {
    const allText = await grid.textContent().catch(() => '');
    
    let stillLoading = false;
    for (const text of loadingTexts) {
      if (allText.toLowerCase().includes(text.toLowerCase())) {
        stillLoading = true;
        break;
      }
    }

    if (!stillLoading) {
      const rows = await grid.locator('tbody tr').count().catch(() => 0);
      if (rows > 0) {
        const firstRowText = await grid.locator('tbody tr').first().textContent().catch(() => '');
        if (firstRowText && firstRowText.trim().length > 5 && !loadingTexts.some(t => firstRowText.toLowerCase().includes(t.toLowerCase()))) {
          logger.info('Grid data loaded', { rowCount: rows });
          return;
        }
      }
    }

    await sleep(3000);
  }

  logger.warn('Timeout waiting for grid data to load, proceeding with current state');
}

async function exportToCsv(page, outputDir, filenameBase, popupPage) {
  logger.info('Extracting grid data from popup page');

  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${filenameBase}.csv`);

  const targetPage = popupPage || page;

  await sleep(2000);

  const exportBtn = targetPage.locator('#btnExport');
  const exportBtnExists = await exportBtn.count().catch(() => 0);
  
  if (exportBtnExists > 0) {
    logger.info('Export button found on popup, capturing CSV');

    let csvBuffer = null;

    await targetPage.route('**/VSPolicy_SummaryReportList.aspx**', async (route) => {
      const response = await route.fetch();
      const ct = response.headers()['content-type'] || '';
      const disp = response.headers()['content-disposition'] || '';
      if (ct.includes('csv') || disp.includes('.csv') || disp.includes('attachment')) {
        logger.info('CSV response intercepted', { contentType: ct, disposition: disp });
        csvBuffer = await response.body();
      }
      await route.fulfill({ response });
    });

    const downloadPromise = targetPage.waitForEvent('download', { timeout: 30000 }).catch(() => null);
    await exportBtn.first().click();
    const download = await downloadPromise;

    if (download) {
      logger.info('CSV download event captured', { suggestedFilename: download.suggestedFilename() });
      await download.saveAs(filePath);
      logger.info('CSV saved via download event', { filePath });
      return filePath;
    }

    await sleep(3000);

    await targetPage.unroute('**/VSPolicy_SummaryReportList.aspx**');

    if (csvBuffer) {
      await fs.writeFile(filePath, csvBuffer);
      logger.info('CSV saved via route interception', { filePath, size: csvBuffer.length });
      return filePath;
    }

    logger.info('Export button click did not produce download, trying POST with fetch');

    const formAction = await targetPage.evaluate(() => {
      const form = document.querySelector('#PolicySummaryReport');
      return form ? form.action : null;
    });

    if (formAction) {
      const response2 = await targetPage.evaluate(async (action) => {
        const resp = await fetch(action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'btnExport=Export+to+CSV'
        });
        return { status: resp.status, contentType: resp.headers.get('content-type') || '', text: await resp.text() };
      }, formAction);

      logger.info('Fetch export response', { status: response2.status, contentType: response2.contentType, textLength: response2.text.length });
      if (response2.text.length > 0) {
        await fs.writeFile(filePath, response2.text, 'utf-8');
        logger.info('CSV saved via fetch export', { filePath, size: response2.text.length });
        return filePath;
      }
    }

    logger.warn('Export button flow failed, falling back to grid extraction');
  }

  const { headers, rows } = await extractGridData(page, popupPage);

  if (!headers.length || !rows.length) {
    throw new Error('No data extracted from grid');
  }

  let csvContent = headers.join(',') + '\n';
  for (const row of rows) {
    const values = headers.map(h => {
      const val = row[h] || '';
      return val.includes(',') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
    });
    csvContent += values.join(',') + '\n';
  }

  await fs.writeFile(filePath, csvContent, 'utf-8');
  logger.info('Grid data saved as CSV', { filePath, rows: rows.length });
  return filePath;
}

async function hasNoRecords(page) {
  const noRecordTexts = [
    'No records', 'No data', 'No Record', 'No record found',
    'No Records Found', 'No Data Found', '0 records',
    'No policy', 'No Policies', 'Record not found'
  ];
  for (const text of noRecordTexts) {
    if (await page.locator(`:has-text("${text}")`).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function parseCsvFile(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim());

  if (!lines.length) {
    return { headers: [], rows: [] };
  }

  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length === 0) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }

  return { headers, rows };
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

async function convertCsvToExcelStyle(csvData) {
  return csvData;
}

export async function downloadKiaSafetyReport(page, { mode = 'kia-safety' } = {}) {
  logger.info('Kia Safety VISOF Insurance Kia data pull started', { mode });

  await loginToKiaSafety(page);
  await ensureOnPolicyReportPage(page);
  await humanPause('on policy report page', 2);

  let startDate, endDate;
  const customFrom = process.env.KIA_SAFETY_FROM_DATE;
  const customTo = process.env.KIA_SAFETY_TO_DATE;

  if (customFrom && customTo) {
    startDate = new Date(customFrom);
    endDate = new Date(customTo);
    logger.info('Custom date range for Kia Safety', {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0]
    });
  } else if (config.kiaSafetyHistoricalBackfillEnabled) {
    startDate = new Date(config.kiaSafetyBackfillStartDate);
    endDate = new Date(config.kiaSafetyBackfillEndDate);
    logger.info('Historical backfill enabled for Kia Safety', { 
      startDate: startDate.toISOString().split('T')[0], 
      endDate: endDate.toISOString().split('T')[0] 
    });
  } else if (mode === 'kia-safety-daily' || config.kiaSafetyDailyModeEnabled) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    startDate = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
    endDate = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
    logger.info('Daily mode for Kia Safety (previous day)', { 
      startDate: startDate.toISOString().split('T')[0], 
      endDate: endDate.toISOString().split('T')[0] 
    });
  } else {
    const now = new Date();
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = now;
    logger.info('Current month mode for Kia Safety', { 
      startDate: startDate.toISOString().split('T')[0], 
      endDate: endDate.toISOString().split('T')[0] 
    });
  }
  const chunks = monthChunks(startDate, endDate);
  const runDir = buildRunDir();

  logger.info('Insurance Kia month chunks prepared', {
    totalMonths: chunks.length,
    startMonth: chunks[0]?.label,
    endMonth: chunks[chunks.length - 1]?.label,
    runDir
  });

  let allHeaders = null;
  const allRows = [];
  let failedMonths = [];

  for (const [index, chunk] of chunks.entries()) {
    logger.info('Processing month chunk', {
      month: chunk.label,
      chunk: `${index + 1}/${chunks.length}`,
      from: chunk.startPortal,
      to: chunk.endPortal
    });

    try {
      let popupPage = null;
      {
        const result = await fillDateRangeAndGo(page, chunk);
        popupPage = result.popupPage;
      }

      let parsed;
      if (await hasNoRecords(page)) {
        logger.info('No records for this month, skipping', { month: chunk.label });
        continue;
      }

      const filenameBase = `insurance_kia_${chunk.label}`;

      const filePath = await exportToCsv(page, runDir, filenameBase, popupPage);
      parsed = await parseCsvFile(filePath);

      if (!parsed.headers.length || !parsed.rows.length) {
        logger.info('Empty data for month chunk', { month: chunk.label });
        continue;
      }

      if (!allHeaders) {
        allHeaders = parsed.headers;
      }

      allRows.push(...parsed.rows);
      logger.info('Month chunk data extracted', {
        month: chunk.label,
        rowsInChunk: parsed.rows.length,
        totalRowsSoFar: allRows.length
      });
    } catch (error) {
      logger.error('Month chunk failed', { month: chunk.label, error: error.message });
      failedMonths.push(chunk.label);
      continue;
    }
  }

  if (!allHeaders || !allRows.length) {
    logger.warn('No data extracted from any month');
    await cleanupReportExportDir(runDir).catch(() => {});
    return {
      name: 'Kia Safety VISOF',
      sheetName: SHEET_NAME,
      dbResult: { action: 'no-data', rowCount: 0, headerCount: 0 },
      failedMonths
    };
  }

  logger.info('Saving Insurance Kia data to relational table', {
    sheetName: SHEET_NAME,
    totalRows: allRows.length,
    headerCount: allHeaders.length,
    headers: allHeaders
  });

  const dbResult = await saveReportSheetToSupabaseRest({
    sheetName: SHEET_NAME,
    headers: allHeaders,
    rows: allRows
  });

  await cleanupReportExportDir(runDir);

  logger.info('Insurance Kia data pull completed', {
    sheetName: SHEET_NAME,
    tableName: 'insurance_kia',
    totalMonths: chunks.length,
    successfulMonths: chunks.length - failedMonths.length,
    failedMonths: failedMonths.length,
    totalRows: allRows.length,
    insertedRowCount: dbResult.insertedRowCount,
    duplicateRowCount: dbResult.duplicateRowCount,
    failedMonthList: failedMonths
  });

  return {
    name: 'Kia Safety VISOF',
    sheetName: SHEET_NAME,
    dbResult: {
      ...dbResult,
      rowCount: allRows.length,
      headerCount: allHeaders.length
    },
    failedMonths
  };
}
