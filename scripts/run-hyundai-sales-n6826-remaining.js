#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
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
import { clickSearch, fillDate } from '../src/reports/report-actions.js';

function getArg(name, defaultValue = null) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : defaultValue;
}

const USER_ID = getArg('user', 'N682600');
const PASSWORD = getArg('password', 'Jammu@6826');
const DEALER_CODE = getArg('dealer', 'N6826').toUpperCase();
const START_DATE = getArg('start', '2017-01-01');
const END_DATE = getArg('end', '2026-06-30');
const RUN_HEADLESS = process.argv.includes('--headless');

const HMIL_LOGIN_URL = 'https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms';

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
  throw new Error(`Could not find visible ${label} (tried: ${selectors.join(', ')})`);
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
  await fillDate(reportContext, '#sDateFromDate', chunk.startPortal, { label: 'Hyundai Sales Report Date From' });
  await fillDate(reportContext, '#sDateToDate', chunk.endPortal, { label: 'Hyundai Sales Report Date To' });
  await selectInvoiceDateRadio(reportContext);
  await clickSearch(reportContext, { label: 'Hyundai Sales Report Search' });

  const postSearchDelay = config.hyundaiSalesReportPostSearchDelayMs || 5000;
  await waitForKendoGridIdle(reportContext, { delayAfterIdleMs: postSearchDelay, timeoutMs: 60000 });
  await selectKendoPagerSizeWithPreferredFallback(reportContext, '1000', ['1000', '300']);
  await waitForKendoGridIdle(reportContext, { timeoutMs: 60000 });
}

function dropGridTotalRows(dataset) {
  if (!dataset?.rows?.length) return dataset;
  const rows = dataset.rows.filter(row => {
    const values = Object.values(row).map(v => String(v ?? '').trim().toUpperCase());
    const isTotal = values.some(v => v === 'TOTAL' || v.startsWith('TOTAL '));
    const regName = String(row['Registration Name'] || row['registration_name'] || row['Customer Name'] || row['customer_name'] || '').trim().toUpperCase();
    if (regName === 'TOTAL' || regName.startsWith('TOTAL')) return false;
    const invNo = String(row['Invoice No'] || row['invoice_no'] || row['Invoice No.'] || '').trim();
    if (!invNo && isTotal) return false;
    return true;
  });
  return { ...dataset, rows };
}

function enrichDataset(merged, fallbackDealerCode = 'N6826') {
  const value = String(fallbackDealerCode || 'N6826').trim().toUpperCase();
  const headers = [...merged.headers];
  for (const header of ['source_dealer_code', 'dealer_code']) {
    if (!headers.includes(header)) headers.unshift(header);
  }
  const rows = merged.rows.map(row => {
    const existingCode = String(row.dealer_code || row.dealer_code_2 || row.main_dealer_code || '').trim().toUpperCase();
    return {
      ...row,
      source_dealer_code: value,
      dealer_code: existingCode || value
    };
  });
  return { headers, rows };
}

async function main() {
  console.log('\n===============================================================');
  console.log('  HYUNDAI SALES REPORT - HISTORICAL FETCH (GREATER JAMMU - N6826)');
  console.log('===============================================================');
  console.log(`  User ID      : ${USER_ID}`);
  console.log(`  Dealer Code  : ${DEALER_CODE}`);
  console.log(`  Date Range   : ${START_DATE}  -->  ${END_DATE}`);
  console.log(`  Headless     : ${RUN_HEADLESS ? 'YES' : 'NO (Visible Browser)'}`);
  console.log(`  OTP Input    : MANUAL ON TERMINAL`);
  console.log(`  Dealer Mode  : Active portal dealer (NO dealer change)`);
  console.log('===============================================================\n');

  const downloadDir = path.resolve(`./downloads/hmil-n6826-sales`);
  const chunkDir = path.join(downloadDir, `chunks_${START_DATE}_to_${END_DATE}`);
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

    const otp = await getOtpManual({ timeoutMs: 180000, purpose: `HMIL (${USER_ID})` });

    console.log(`\n[INFO] Submitting OTP: ${otp}`);
    const otpInput = await firstVisible(page, OTP_INPUT_SELECTORS, { label: 'OTP Input Field' });
    await otpInput.fill(otp);

    const submitBtn = await firstVisible(page, SUBMIT_SELECTORS, { label: 'Login Button' });
    await submitBtn.click();

    console.log('[INFO] Waiting for dashboard navigation...');
    await page.waitForURL(/selectHome\.dms|selectLoginAction|ndms\.hmil\.net/i, { timeout: 45000 });
    await page.waitForLoadState('domcontentloaded');
    await sleep(3000);
    console.log('[SUCCESS] Logged in successfully to HMIL GDMS!\n');

    console.log('[4/4] Opening Sales Report page...');
    await openHmilSalesReport(page);

    const reportContext = await findContextWithVisibleSelector(page, '#sDateFromDate', {
      timeout: 60000,
      label: 'Hyundai Sales Report Date From'
    });
    await reportContext.locator('#sDateToDate').first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('[SUCCESS] Hyundai Sales Report page ready.\n');

    const markerPath = baseName => path.join(chunkDir, `${baseName}.saved.json`);
    const alreadySaved = baseName => fs.readFile(markerPath(baseName), 'utf8').then(() => true).catch(() => false);

    let totalSavedRows = 0;
    let completedChunks = 0;
    let skippedChunks = 0;
    const failedChunks = [];

    for (const [index, chunk] of chunks.entries()) {
      const baseName = chunkFileName(chunk);
      const progress = `[${index + 1}/${chunks.length}]`;
      const dateRangeStr = `${chunk.startPortal} to ${chunk.endPortal}`;

      if (await alreadySaved(baseName)) {
        skippedChunks += 1;
        console.log(`${progress} SKIP ${dateRangeStr} (already saved)`);
        continue;
      }

      console.log(`${progress} FETCHING ${dateRangeStr} ...`);

      try {
        await applyDateRangeAndSearch(reportContext, chunk);

        const chunkFiles = await exportAllGridPagesToFiles(reportContext, {
          outputDir: chunkDir,
          filenameBase: baseName,
          downloadTimeoutMs: 180000
        }) ?? [];

        let rowCount = 0;
        if (chunkFiles.length) {
          const merged = dropGridTotalRows(await mergeExcelFiles(chunkFiles));
          const enrichedDataset = enrichDataset(merged, DEALER_CODE);

          const dbResult = await saveReportSheetToSupabase({
            brand: 'hyundai',
            sheetName: 'hyundai_sales_report',
            headers: enrichedDataset.headers,
            rows: enrichedDataset.rows
          });

          rowCount = enrichedDataset.rows.length;
          totalSavedRows += rowCount;
          console.log(`    --> SUCCESS: ${rowCount} rows saved to database (inserted: ${dbResult.insertedCount ?? 0}, updated: ${dbResult.updatedCount ?? 0})`);
        } else {
          console.log(`    --> NO DATA (0 rows in this date range)`);
        }

        await fs.writeFile(
          markerPath(baseName),
          JSON.stringify({
            dealerCode: DEALER_CODE,
            start: chunk.startIso,
            end: chunk.endIso,
            rowCount,
            savedAt: new Date().toISOString()
          }, null, 2)
        );

        for (const file of chunkFiles) {
          await fs.unlink(file).catch(() => {});
        }

        completedChunks += 1;
      } catch (chunkError) {
        console.error(`    --> ERROR on chunk ${dateRangeStr}: ${chunkError.message}`);
        logger.error('Error processing sales report chunk', {
          dealerCode: DEALER_CODE,
          chunk: progress,
          error: chunkError.message
        });
        failedChunks.push({ chunk: progress, range: dateRangeStr, error: chunkError.message });
      }

      const betweenDelay = config.hyundaiSalesReportBetweenChunksDelayMs || 4000;
      await sleep(betweenDelay);
    }

    console.log('\n===============================================================');
    console.log('  HISTORICAL FETCH COMPLETE (GREATER JAMMU - N6826)');
    console.log('===============================================================');
    console.log(`  Dealer Code      : ${DEALER_CODE}`);
    console.log(`  Date Range       : ${START_DATE} to ${END_DATE}`);
    console.log(`  Total Chunks     : ${chunks.length}`);
    console.log(`  Completed        : ${completedChunks}`);
    console.log(`  Skipped (Cached) : ${skippedChunks}`);
    console.log(`  Failed Chunks    : ${failedChunks.length}`);
    console.log(`  Total Rows Saved : ${totalSavedRows}`);
    console.log('===============================================================\n');

    if (failedChunks.length > 0) {
      console.log('Failed Chunks Detail:');
      console.table(failedChunks);
      console.log('Tip: You can re-run the exact same command to automatically retry failed chunks.\n');
    }
  } finally {
    console.log('[INFO] Closing browser session...');
    await browser.close().catch(() => {});
    console.log('[DONE] Process finished.');
  }
}

main().catch(err => {
  console.error('\n[FATAL ERROR]', err);
  process.exit(1);
});