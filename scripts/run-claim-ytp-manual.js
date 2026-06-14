import { createHmilWarrantyAccounts } from '../src/accounts/hmil-warranty-accounts.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { config } from '../src/config.js';
import {
  openHmilWarrantyClaim
} from '../src/navigation/hmil-menu.js';
import { findContextWithVisibleSelector } from '../src/playwright/frame-resolver.js';
import {
  formatDateForPortal,
  parseIsoLocalDate,
  toIsoDate
} from '../src/utils/date-range.js';
import { logger } from '../src/utils/logger.js';
import { sleep } from '../src/utils/sleep.js';
import { waitForKendoGridIdle, selectKendoPagerSize } from '../src/reports/grid.js';
import {
  extractAllGridPagesFromDom,
  exportAllGridPagesToFiles,
  mergeExcelFiles
} from '../src/reports/paged-export.js';
import { fillDate, clickSearch } from '../src/reports/report-actions.js';
import { saveReportSheetToSupabase } from '../src/supabase/report-store.js';
import fs from 'node:fs/promises';
import path from 'node:path';

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

const account = createHmilWarrantyAccounts()
  .find(candidate => candidate.id === 'hmil-warranty-primary');

if (!account) {
  throw new Error('Could not resolve sahiltech (hmil-warranty-primary) account');
}

const manualAccount = { ...account, otpProvider: 'manual', headless: false };

const REPORT_NAME = 'Hyundai Warranty Claim YTP';
const SHEET_NAME = 'Hyundai Warranty Claim YTP';
const GRID_ID = 'gridClaimYtp';
const PAGE_SIZE = '300';

async function main() {
  const session = await loginToHmilDms(manualAccount);
  const today = new Date();
  const endDateStr = formatDateForPortal(today);

  const range = {
    startPortal: '01/01/2025',
    endPortal: endDateStr,
    startIso: '2025-01-01',
    endIso: toIsoDate(today)
  };

  logger.info('Using date range', { range });

  await openHmilWarrantyClaim(session.page);
  const context = await findContextWithVisibleSelector(session.page, '#ro', {
    timeout: 90000,
    label: `${REPORT_NAME} ready selector`
  });

  await activateClaimYtpTab(context);
  logger.info('Tab activated, waiting 2 seconds');
  await sleep(2000);

  await fillDate(context, '#sRoFromDate', range.startPortal);
  logger.info('From date entered', { value: range.startPortal });
  await sleep(1000);

  await fillDate(context, '#sRoToDate', range.endPortal);
  logger.info('To date entered', { value: range.endPortal });
  await sleep(2000);

  logger.info('Clicking Search after date range');
  await clickSearch(context);
  await waitForKendoGridIdle(context, {
    gridSelector: `#${GRID_ID}`,
    timeout: 120000
  });
  await sleep(2000);

  const pagerSizeLocator = context.locator(`#${GRID_ID} .k-pager-sizes`).first();
  await pagerSizeLocator.waitFor({ state: 'visible', timeout: 60000 });

  const dropdownWrap = pagerSizeLocator.locator('.k-dropdown-wrap').first();
  await dropdownWrap.waitFor({ state: 'visible', timeout: 30000 });
  logger.info('Clicking dropdown to open page-size options');
  await dropdownWrap.click({ force: true });
  await sleep(1000);

  const selectLocator = pagerSizeLocator.locator('select[data-role="dropdownlist"]').first();
  await selectLocator.waitFor({ state: 'visible', timeout: 10000 });

  const selected = await selectLocator.selectOption({ value: PAGE_SIZE });
  logger.info('Selected page size via native select', { selected });

  await sleep(2000);

  logger.info('Waiting for grid data to load');
  await waitForKendoGridIdle(context, {
    gridSelector: `#${GRID_ID}`,
    timeout: 120000
  });
  await sleep(2000);

  const selectedPageSize = await selectKendoPagerSize(context, PAGE_SIZE, { timeout: 30000 });
  logger.info('Page size after selection', { selectedPageSize, expected: PAGE_SIZE });

  const outputDir = path.join(
    account.reportChunksDir,
    'hyundai-warranty-claim-ytp',
    account.userId,
    `${range.startIso}_to_${range.endIso}_${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  await fs.mkdir(outputDir, { recursive: true });

  const filenameBase = `hyundai_warranty_claim_ytp_${account.userId}_${range.startIso.replaceAll('-', '_')}_to_${range.endIso.replaceAll('-', '_')}`;
  const exportSelector = 'a.k-grid-excel[onclick*="gridClaimYtp"]';

  let pageFiles = [];
  let merged;
  let pageCount = 0;

  try {
    pageFiles = await exportAllGridPagesToFiles(context, {
      outputDir,
      filenameBase,
      pageSize: Number.parseInt(PAGE_SIZE, 10),
      downloadTimeoutMs: 10000,
      maxPages: 500,
      exportSelector,
      exportWhenEmpty: true,
      emptyDownloadTimeoutMs: 5000,
      gridSelector: `#${GRID_ID}`
    });
    pageCount = pageFiles.length;
    if (pageFiles.length) {
      merged = await mergeExcelFiles(pageFiles);
    }
  } catch (error) {
    logger.warn('Excel download not captured; extracting grid rows directly', { error: error.message });
    const extracted = await extractAllGridPagesFromDom(context, {
      pageSize: Number.parseInt(PAGE_SIZE, 10),
      maxPages: 500,
      gridSelector: `#${GRID_ID}`
    });
    merged = { headers: extracted.headers, rows: extracted.rows };
    pageCount = extracted.pageCount;
  }

  if (!merged?.rows.length) {
    await fs.rm(outputDir, { recursive: true, force: true });
    logger.info('No rows found for Claim YTP', { range });
    console.log('\nRESULT: no_rows');
    await session.close?.().catch(() => {});
    return;
  }

  const rowsWithSource = merged.rows.map(row => ({ ...row, source_login_id: account.userId }));
  const dbResult = await saveReportSheetToSupabase({
    brand: 'hyundai',
    sheetName: SHEET_NAME,
    headers: merged.headers,
    rows: rowsWithSource
  });

  await fs.rm(outputDir, { recursive: true, force: true });

  logger.info('Claim YTP run complete', {
    rowCount: merged.rows.length,
    pageCount,
    range,
    dbResult
  });

  console.log('\nRESULT:', JSON.stringify({
    status: 'success',
    report: REPORT_NAME,
    range,
    rowCount: merged.rows.length,
    pageCount,
    headerCount: merged.headers.length,
    dbResult
  }, null, 2));

  await session.close?.().catch(() => {});
}

main().catch((error) => {
  logger.error('Claim YTP manual run failed', { error: error.message, stack: error.stack });
  console.log('\nRESULT:', JSON.stringify({ status: 'failed', error: error.message }, null, 2));
  process.exitCode = 1;
});
