#!/usr/bin/env node
// Channi / GK (N6819) Remaining Sales Report Fetcher (Sept 2025 -> June 2026)
// Login: N681900 / Jammu@6819 | Dealer: N6819 (Preserves active portal dealer)
// OTP: Manual prompt in terminal

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { openHmilSalesReport } from '../src/navigation/hmil-menu.js';
import { findContextWithVisibleSelector } from '../src/playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../src/supabase/report-store.js';
import { getThirtyDayChunks, parseIsoLocalDate, toIsoDate } from '../src/utils/date-range.js';
import { logger } from '../src/utils/logger.js';
import { sleep } from '../src/utils/sleep.js';
import { getOtpManual } from '../src/otp/manual.js';
import { selectKendoPagerSizeWithPreferredFallback, waitForKendoGridIdle } from '../src/reports/grid.js';
import { exportAllGridPagesToFiles, mergeExcelFiles } from '../src/reports/paged-export.js';
import { addSourceDealerCodeToDataset } from '../src/reports/report-metadata.js';
import { clickSearch, fillDate } from '../src/reports/report-actions.js';

function getArg(name, defaultValue = null) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : defaultValue;
}

const USER_ID = getArg('user', 'N681900');
const PASSWORD = getArg('password', 'Jammu@6819');
const DEALER_CODE = getArg('dealer', 'N6819').toUpperCase();
const START_DATE = getArg('start', '2025-09-01');
const END_DATE = getArg('end', '2026-06-30');
const RUN_HEADLESS = process.argv.includes('--headless');

const HMIL_LOGIN_URL = 'https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms';
const HMIL_HOME_URL = 'https://ndms.hmil.net/cmm/cmmd/selectHome.dms';

const USER_SELECTORS = ['#usrId', '#userId', '#loginId', 'input[name="usrId"]', 'input[name="userId"]'];
const PASSWORD_SELECTORS = ['#usrPswdNo', '#password', '#pwd', 'input[name="usrPswdNo"]', 'input[type="password"]'];
const SEND_OTP_SELECTORS = ['#btnGenerateOtp', '#btnSendOtp', '#btnSendOTP', 'button:has-text("Send OTP")', 'input[value*="Send OTP" i]'];
const OTP_INPUT_SELECTORS = ['#otpEnter', 'input[name*="otp" i]', 'input[id*="otp" i]'];
const SUBMIT_SELECTORS = ['#btnLoginClickGdmsNew', '#btnLogin', '#btnSubmit', 'button:has-text("Login")', 'input[value*="Login" i]'];

async function firstVisible(page, selectors, { timeout = 15000, label = 'control' } = {}) {
  const startedAt = Date.now();
  for (const selector of selectors) {
    const remainingMs = timeout - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    const loc = page.locator(selector).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: Math.min(remainingMs, 1000) });
      return loc;
    } catch {}
  }
  throw new Error(`Could not find visible ${label}`);
}

function chunkFileName(chunk) {
  const start = chunk.startIso.replaceAll('-', '_');
  const end = chunk.endIso.replaceAll('-', '_');
  return `hyundai_sales_report_${start}_to_${end}`;
}

async function selectInvoiceDateRadio(context) {
  const radio = context.locator([
    '#invoiceDate',
    '#invoicedate',
    'input[type="radio"][value="invoiceDate"]',
    'input[type="radio"][name="radio"][value="invoiceDate"]',
    'label:has-text("Invoice Date") input[type="radio"]',
    'label:has-text("Invoice date") input[type="radio"]'
  ].join(',')).first();

  await radio.waitFor({ state: 'visible', timeout: 30000 });
  await radio.check({ force: true }).catch(async () => {
    await radio.click({ force: true });
  });
}

async function applyDateRangeAndSearch(reportContext, chunk) {
  await fillDate(reportContext, '#sDateFromDate', chunk.startPortal, {
    label: 'Hyundai Sales Report Date From'
  });
  await fillDate(reportContext, '#sDateToDate', chunk.endPortal, {
    label: 'Hyundai Sales Report Date To'
  });
  await selectInvoiceDateRadio(reportContext);
  await clickSearch(reportContext, { label: 'Hyundai Sales Report Search' });

  const postSearchDelay = config.hyundaiSalesReportPostSearchDelayMs || 5000;
  await waitForKendoGridIdle(reportContext, {
    delayAfterIdleMs: postSearchDelay,
    timeoutMs: 60000
  });

  await selectKendoPagerSizeWithPreferredFallback(reportContext, '1000', ['1000', '300']);
  await waitForKendoGridIdle(reportContext, { timeoutMs: 60000 });
}

function dropGridTotalRows(dataset) {
  if (!dataset || !Array.isArray(dataset.rows)) return dataset;
  const filteredRows = dataset.rows.filter(row => {
    const rawValues = Object.values(row).map(v => String(v ?? '').trim().toUpperCase());
    const isTotalRow = rawValues.some(v => v === 'TOTAL' || v === 'GRAND TOTAL');
    const hasData = row.invoice_no || row.vin_number || row.vin || row.model;
    return !(isTotalRow && !hasData);
  });
  return { ...dataset, rows: filteredRows };
}

async function exportAndSaveChunk(reportContext, chunk, chunkDir) {
  const baseName = chunkFileName(chunk);
  const markerFile = path.join(chunkDir, `${baseName}.saved.json`);

  try {
    const stat = await fs.stat(markerFile);
    if (stat.isFile()) {
      console.log(`[SKIP] Chunk ${chunk.startIso} -> ${chunk.endIso} already downloaded and saved.`);
      return { skipped: true, rowCount: 0 };
    }
  } catch {}

  console.log(`\n-----------------------------------------------------------`);
  console.log(`[FETCHING] Date Range: ${chunk.startPortal} -> ${chunk.endPortal}`);
  console.log(`-----------------------------------------------------------`);

  await applyDateRangeAndSearch(reportContext, chunk);

  const exportResult = await exportAllGridPagesToFiles(reportContext, {
    downloadDir: chunkDir,
    filenameBase: baseName,
    pageSize: 1000,
    preferredPagerSizes: ['1000', '300'],
    exportWhenEmpty: false,
    reportId: 'hyundai-sales-report'
  });

  if (!exportResult.exportedFiles || exportResult.exportedFiles.length === 0) {
    console.log(`[INFO] No sales records found for ${chunk.startPortal} -> ${chunk.endPortal} (0 rows).`);
    await fs.writeFile(markerFile, JSON.stringify({
      dealerCode: DEALER_CODE,
      start: chunk.startIso,
      end: chunk.endIso,
      rowCount: 0,
      savedAt: new Date().toISOString()
    }, null, 2));
    return { skipped: false, rowCount: 0 };
  }

  const merged = await mergeExcelFiles(exportResult.exportedFiles);
  addSourceDealerCodeToDataset(merged, DEALER_CODE);
  const cleanDataset = dropGridTotalRows(merged);

  console.log(`[INFO] Downloaded ${cleanDataset.rows.length} sales rows. Saving to Supabase/Postgres...`);

  const dbResult = await saveReportSheetToSupabase({
    sheetName: 'hyundai_sales_report',
    dataset: cleanDataset,
    dealerCode: DEALER_CODE,
    uploadedAt: new Date(),
    tableName: 'hyundai_sales_report'
  });

  console.log(`[SUCCESS] Database upload complete: ${cleanDataset.rows.length} rows stored.`);

  await fs.writeFile(markerFile, JSON.stringify({
    dealerCode: DEALER_CODE,
    start: chunk.startIso,
    end: chunk.endIso,
    rowCount: cleanDataset.rows.length,
    savedAt: new Date().toISOString()
  }, null, 2));

  return { skipped: false, rowCount: cleanDataset.rows.length };
}

async function main() {
  console.log('===============================================================');
  console.log('  HYUNDAI SALES REPORT - CHANNI / GK (N6819) REMAINING RUNNER');
  console.log('===============================================================');
  console.log(`  User ID      : ${USER_ID}`);
  console.log(`  Dealer Code  : ${DEALER_CODE}`);
  console.log(`  Date Range   : ${START_DATE}  -->  ${END_DATE}`);
  console.log(`  Headless     : ${RUN_HEADLESS ? 'YES' : 'NO (Visible Browser)'}`);
  console.log(`  OTP Input    : MANUAL ON TERMINAL`);
  console.log('===============================================================\n');

  const downloadDir = path.resolve(`./downloads/hmil-n6819-sales`);
  const chunkDir = path.join(downloadDir, `chunks_2010-01-01_to_2026-06-30`);
  await fs.mkdir(chunkDir, { recursive: true });

  const sDate = parseIsoLocalDate(START_DATE);
  const eDate = parseIsoLocalDate(END_DATE);
  const chunks = getThirtyDayChunks(sDate, eDate);

  console.log(`[INFO] Prepared ${chunks.length} thirty-day date chunks to process.\n`);

  console.log('[1/4] Launching browser...');
  const browser = await chromium.launch({
    headless: RUN_HEADLESS,
    slowMo: config.slowMoMs || 50,
    downloadsPath: downloadDir,
    args: RUN_HEADLESS ? [] : ['--start-maximized']
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: RUN_HEADLESS ? undefined : null
  });
  context.setDefaultTimeout(60000);
  context.setDefaultNavigationTimeout(60000);

  const page = await context.newPage();

  try {
    console.log(`[2/4] Navigating to HMIL login: ${HMIL_LOGIN_URL}`);
    await page.goto(HMIL_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);

    const userInput = await firstVisible(page, USER_SELECTORS, { label: 'User ID' });
    await userInput.fill('');
    await userInput.fill(USER_ID);

    const passInput = await firstVisible(page, PASSWORD_SELECTORS, { label: 'Password' });
    await passInput.fill(PASSWORD);

    console.log('[3/4] Requesting OTP from GDMS...');
    const sendOtpBtn = await firstVisible(page, SEND_OTP_SELECTORS, { label: 'Send OTP Button' });
    await sendOtpBtn.click();

    await firstVisible(page, OTP_INPUT_SELECTORS, { timeout: 30000, label: 'OTP Input Field' });
    console.log('\n>>> OTP SENT TO REGISTERED MOBILE NUMBER <<<');

    const otp = await getOtpManual({
      timeoutMs: 180000,
      purpose: `HMIL (${USER_ID})`
    });

    console.log(`\n[INFO] Submitting OTP: ${otp}`);
    const otpField = await firstVisible(page, OTP_INPUT_SELECTORS, { label: 'OTP Field' });
    await otpField.fill('');
    await otpField.fill(otp);

    const submitBtn = await firstVisible(page, SUBMIT_SELECTORS, { label: 'Login Button' });
    await submitBtn.click();
    await sleep(5000);

    console.log('[4/4] Opening Sales Report menu...');
    await openHmilSalesReport(page, { timeoutMs: 60000 });

    const reportContext = await findContextWithVisibleSelector(
      page,
      ['#sDateFromDate', '#sDateToDate', '#btnSearch', '.k-grid'],
      { timeoutMs: 60000, label: 'Hyundai Sales Report Form' }
    );

    console.log('[INFO] Sales Report loaded successfully. Starting date chunk downloads...\n');

    let totalSaved = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`\n>>> [CHUNK ${i + 1} / ${chunks.length}] : ${chunk.startPortal} to ${chunk.endPortal}`);
      const res = await exportAndSaveChunk(reportContext, chunk, chunkDir);
      totalSaved += res.rowCount;
      await sleep(2000);
    }

    console.log('\n===============================================================');
    console.log(`🎉 COMPLETED ALL CHUNKS FOR CHANNI / GK (${DEALER_CODE})`);
    console.log(`   Total Rows Inserted: ${totalSaved}`);
    console.log('===============================================================');

  } catch (err) {
    console.error(`\n❌ Error during execution: ${err.message}`);
    const errorShot = path.join(downloadDir, `kathua-sales-error-${Date.now()}.png`);
    await page.screenshot({ path: errorShot, fullPage: true }).catch(() => {});
    console.log(`Saved failure screenshot: ${errorShot}`);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
