import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { config } from '../src/config.js';
import { createAmPlatinumAccount } from '../src/accounts/am-platinum-accounts.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { openRoBillingReport, openAdvWiseLubricantsVasReport } from '../src/navigation/kia-menu.js';
import { openHmilRepairOrderListReport } from '../src/navigation/hmil-menu.js';
import { findContextWithVisibleSelector } from '../src/playwright/frame-resolver.js';
import { selectKendoPagerSizeWithPreferredFallback, waitForKendoGridIdle } from '../src/reports/grid.js';
import {
  exportAllGridPagesToFiles,
  mergeExcelFiles,
  gridHasNoExportableData
} from '../src/reports/paged-export.js';
import { fillDate, selectKendoDropdownByInputId } from '../src/reports/report-actions.js';
import { sleep } from '../src/utils/sleep.js';
import { logger } from '../src/utils/logger.js';

// ─── Configuration ────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(config.rootDir, 'downloads', 'may_2026_platinum');
const CHUNK_BASE = path.join(config.amPlatinumReportChunksDir, 'may2026_temp');

const RANGE = {
  startPortal: '01/05/2026',
  endPortal: '31/05/2026',
  startIso: '2026-05-01',
  endIso: '2026-05-31'
};

// ─── Reports to run ───────────────────────────────────────────────────────────
const REPORTS = [
  {
    id: 'ro_billing',
    name: 'RO Billing Report',
    open: openRoBillingReport,
    dateFromSelector: '#sBillDateFromDate',
    dateToSelector: '#sBillDateToDate',
    setup: null
  },
  {
    id: 'repair_order',
    name: 'Repair Order List',
    open: openHmilRepairOrderListReport,
    dateFromSelector: '#sRoStrtDate',
    dateToSelector: '#sRoFnshDate',
    setup: null
  },
  {
    id: 'operation_wise_operation',
    name: 'Operation Wise Analysis (Operation)',
    open: openAdvWiseLubricantsVasReport,
    dateFromSelector: '#startDate',
    dateToSelector: '#endDate',
    setup: async (context) => {
      await selectKendoDropdownByInputId(context, 'dateType', 'Billing Date');
      await waitForKendoGridIdle(context, { timeout: 30000 });
      await selectKendoDropdownByInputId(context, 'reportType', 'Operation');
      await waitForKendoGridIdle(context, { timeout: 30000 });
    }
  },
  {
    id: 'operation_wise_part',
    name: 'Operation Wise Analysis (Part)',
    open: openAdvWiseLubricantsVasReport,
    dateFromSelector: '#startDate',
    dateToSelector: '#endDate',
    setup: async (context) => {
      await selectKendoDropdownByInputId(context, 'dateType', 'Billing Date');
      await waitForKendoGridIdle(context, { timeout: 30000 });
      await selectKendoDropdownByInputId(context, 'reportType', 'Part');
      await waitForKendoGridIdle(context, { timeout: 30000 });
    }
  },
  {
    id: 'adv_lubricants_vas',
    name: 'Adv. wise lubricants & VAS',
    open: openAdvWiseLubricantsVasReport,
    dateFromSelector: '#startDate',
    dateToSelector: '#endDate',
    setup: async (context) => {
      await selectKendoDropdownByInputId(context, 'dateType', 'Billing Date');
      await waitForKendoGridIdle(context, { timeout: 30000 });
    }
  }
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function safeMkdir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function safeRm(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function writeMergedExcel(headers, rows, outputPath) {
  await safeMkdir(path.dirname(outputPath));
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('May 2026');
  worksheet.columns = headers.map(h => ({ header: h, key: h, width: 20 }));
  for (const row of rows) {
    worksheet.addRow(row);
  }
  await workbook.xlsx.writeFile(outputPath);
  logger.info(`Saved Excel file: ${outputPath}`, { rows: rows.length });
}

async function clickSearch(context) {
  const searchBtn = context.locator([
    '#btnSearch',
    'button:has-text("Search")',
    'a:has-text("Search")',
    'input[type="button"][value="Search"]',
    'input[type="submit"][value="Search"]'
  ].join(',')).first();
  await searchBtn.waitFor({ state: 'visible', timeout: 30000 });
  await searchBtn.click();
}

// ─── Single report runner ─────────────────────────────────────────────────────
async function runReport(page, report, dealerCode) {
  logger.info(`\n  Running: ${report.name} for dealer ${dealerCode}`);

  // Navigate to report
  await report.open(page);
  await sleep(1500);

  // Wait for date input to become visible
  const context = await findContextWithVisibleSelector(page, report.dateFromSelector, {
    timeout: 90000,
    label: `${report.name} form`
  });
  await context.locator(report.dateToSelector).first().waitFor({ state: 'visible', timeout: 30000 });

  // Apply report-specific dropdown setup (dateType, reportType)
  if (report.setup) {
    await report.setup(context);
  }

  // Fill dates: end first, then start (prevents portal from clearing start)
  await fillDate(context, report.dateToSelector, RANGE.endPortal);
  await fillDate(context, report.dateFromSelector, RANGE.startPortal);

  // Click Search
  await clickSearch(context);
  await waitForKendoGridIdle(context, { timeout: 120000 });

  // Check for empty grid
  const emptyCheck = await gridHasNoExportableData(context, '300');
  if (emptyCheck.noData) {
    logger.info(`  [SKIP] Grid has no data for ${report.name} [${dealerCode}]`);
    return { status: 'no_data' };
  }

  // Set page size to maximum available
  const selectedPageSize = await selectKendoPagerSizeWithPreferredFallback(
    context,
    ['1000', '500', '300'],
    { visibleClick: true, timeout: 300000 }
  );
  await waitForKendoGridIdle(context, { timeout: 120000 });

  // Export pages to temp chunk directory
  const chunkDir = path.join(CHUNK_BASE, report.id, dealerCode);
  await safeMkdir(chunkDir);
  const filenameBase = `${report.id}_${dealerCode}_may_2026`;

  logger.info(`  Exporting pages...`);
  const pageFiles = await exportAllGridPagesToFiles(context, {
    outputDir: chunkDir,
    filenameBase,
    pageSize: selectedPageSize,
    downloadTimeoutMs: 60000,
    maxPages: 1000
  });

  if (!pageFiles.length) {
    logger.warn(`  [WARN] No files downloaded for ${report.name} [${dealerCode}]`);
    await safeRm(chunkDir);
    return { status: 'no_files' };
  }

  // Merge exported Excel chunks
  logger.info(`  Merging ${pageFiles.length} page file(s)...`);
  const merged = await mergeExcelFiles(pageFiles);

  // Prepend source_dealer_code column
  const finalHeaders = ['source_dealer_code', ...merged.headers.filter(h => h !== 'source_dealer_code')];
  const finalRows = merged.rows.map(row => ({
    source_dealer_code: dealerCode,
    ...Object.fromEntries(finalHeaders.slice(1).map(h => [h, row[h] ?? '']))
  }));

  // Write merged file to output folder
  const outputPath = path.join(OUTPUT_DIR, `${report.id}_${dealerCode}_may_2026.xlsx`);
  await writeMergedExcel(finalHeaders, finalRows, outputPath);

  // Cleanup chunks
  await safeRm(chunkDir);

  return { status: 'success', rowCount: finalRows.length, file: outputPath };
}

// ─── Session runner (one per login account) ───────────────────────────────────
async function runSession(accountKey, dealers) {
  const baseAccount = createAmPlatinumAccount(accountKey);
  const account = {
    ...baseAccount,
    headless: false,
    otpProvider: 'manual',
    forceLogin: true
  };

  logger.info(`\n${'═'.repeat(80)}`);
  logger.info(`SESSION START | user=${account.userId} | dealers=${dealers.join(', ')}`);
  logger.info('═'.repeat(80));

  const session = await loginToHmilDms(account);
  const { page } = session;
  logger.info(`Logged in as ${account.userId}\n`);

  const results = [];
  let lastDealer = null;

  try {
    for (const dealerCode of dealers) {
      logger.info(`\n${'─'.repeat(60)}`);
      logger.info(`Dealer: ${dealerCode}`);
      logger.info('─'.repeat(60));

      // Change active dealer
      if (lastDealer !== dealerCode) {
        await changeActiveDealerForDms(page, dealerCode, {
          homeUrl: account.homeUrl,
          systemLabel: account.systemLabel
        });
        lastDealer = dealerCode;
        await sleep(2000);
      }

      // Run each report for this dealer
      for (const report of REPORTS) {
        try {
          const result = await runReport(page, report, dealerCode);
          results.push({ dealerCode, reportId: report.id, reportName: report.name, ...result });
        } catch (err) {
          logger.error(`  [ERROR] ${report.name} [${dealerCode}]: ${err.message}`);
          results.push({
            dealerCode,
            reportId: report.id,
            reportName: report.name,
            status: 'error',
            error: err.message
          });
        }

        // Small pause between reports to let the portal settle
        await sleep(2000);
      }
    }
  } finally {
    await session.close().catch(() => {});
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('\n' + '═'.repeat(80));
  logger.info('AM PLATINUM - MAY 2026 LOCAL EXPORT');
  logger.info('Date range: 01/05/2026 to 31/05/2026');
  logger.info(`Output folder: ${OUTPUT_DIR}`);
  logger.info('Database: DISABLED (local only)');
  logger.info('OTP: manual (enter in terminal)');
  logger.info('═'.repeat(80) + '\n');

  await safeMkdir(OUTPUT_DIR);

  const allResults = [];

  // ── Session 1: Historical account (MIS12345) for N5211, N6828 ──
  try {
    const histResults = await runSession('historical', ['N5211', 'N6828']);
    allResults.push(...histResults);
  } catch (err) {
    logger.error('Historical session failed:', err);
  }

  // ── Session 2: Current account (MIS1988) for N6250 ──
  try {
    const currResults = await runSession('current', ['N6250']);
    allResults.push(...currResults);
  } catch (err) {
    logger.error('Current session failed:', err);
  }

  // ── Summary ──
  logger.info('\n' + '═'.repeat(80));
  logger.info('FINAL SUMMARY');
  logger.info('═'.repeat(80));
  for (const r of allResults) {
    if (r.status === 'success') {
      logger.info(`  ✅ ${r.reportName} [${r.dealerCode}]: ${r.rowCount} rows → ${r.file}`);
    } else if (r.status === 'no_data') {
      logger.info(`  ⬜ ${r.reportName} [${r.dealerCode}]: No data found for May 2026`);
    } else {
      logger.info(`  ❌ ${r.reportName} [${r.dealerCode}]: ${r.error || r.status}`);
    }
  }
  logger.info('═'.repeat(80));

  const succeeded = allResults.filter(r => r.status === 'success').length;
  const total = allResults.length;
  logger.info(`\nCompleted: ${succeeded}/${total} reports extracted successfully`);
  logger.info(`Files saved in: ${OUTPUT_DIR}\n`);
}

main().catch(err => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
