import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { openAdvWiseLubricantsVasReport } from '../src/navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../src/playwright/frame-resolver.js';
import { saveReportSheetToRelationalTable, normalizeTableName } from '../src/supabase/relational-store.js';
import { withPostgresClient } from '../src/supabase/postgres.js';
import {
  formatDateForPortal,
  parseIsoLocalDate,
  toIsoDate
} from '../src/utils/date-range.js';
import { executeWithRetry } from '../src/utils/execute-with-retry.js';
import { logger } from '../src/utils/logger.js';
import { retry } from '../src/utils/retry.js';
import { selectKendoPagerSizeByVisibleClick, waitForKendoGridIdle } from '../src/reports/grid.js';
import {
  cleanupReportExportDir,
  exportAllGridPagesToFiles,
  getPagerState,
  mergeExcelFiles
} from '../src/reports/paged-export.js';
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByInputId
} from '../src/reports/report-actions.js';
import { sleep } from '../src/utils/sleep.js';

// ─── Configuration ──────────────────────────────────────────────

const START_DATE = '2021-01-01';
const END_DATE = toIsoDate(new Date());
const SHEET_NAME = 'AM Platinum Operation Wise Analysis Report';
const TABLE_NAME = normalizeTableName(SHEET_NAME);
const REPORT_TYPES = ['Operation', 'Part'];
const PAGE_SIZE = '1000';
const PAGE_SIZE_NUM = 1000;
const STATE_FILE = path.join(config.logsDir, 'am-platinum-operation-wise-recovery-state.json');

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function createAccount() {
  const account = createGdmsAccountProfile('am-platinum');
  if (process.env.AM_PLATINUM_HISTORICAL_HEADLESS != null && process.env.AM_PLATINUM_HISTORICAL_HEADLESS !== '') {
    account.headless = envBool('AM_PLATINUM_HISTORICAL_HEADLESS', config.headless);
  }
  return account;
}

// ─── Helper functions ───────────────────────────────────────────

function monthKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0')
  ].join('-');
}

function minDate(left, right) {
  return left < right ? left : right;
}

function maxDate(left, right) {
  return left > right ? left : right;
}

function isActiveDealerAlias(dealerCode) {
  return !dealerCode || ['active', 'current', 'default'].includes(String(dealerCode).trim().toLowerCase());
}

function rangeFromDates(startDate, endDate) {
  const reportMonth = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  return {
    monthKey: monthKey(startDate),
    startDate,
    endDate,
    reportMonth,
    reportMonthIso: toIsoDate(reportMonth),
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

function getMonthlySafeRanges(startIso, endIso) {
  const ranges = [];
  const startDate = parseIsoLocalDate(startIso);
  const finalEnd = parseIsoLocalDate(endIso);
  let monthCursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  while (monthCursor <= finalEnd) {
    const firstOfMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
    const lastOfMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0);
    const monthStart = maxDate(firstOfMonth, startDate);
    const monthEnd = minDate(lastOfMonth, finalEnd);
    ranges.push(rangeFromDates(monthStart, monthEnd));
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
  }

  return ranges;
}

function sanitizeName(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return result.rows[0].exists;
}

async function loadResumeState(dealerCodes) {
  if (process.env.FORCE_RECOVERY === 'true') {
    return {
      dealerIndex: 0,
      reportTypeIndex: 0,
      rangeIndex: 0,
      startDate: START_DATE,
      endDate: END_DATE,
      dealerCodes
    };
  }

  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    const sameScope =
      state.startDate === START_DATE &&
      state.endDate === END_DATE &&
      JSON.stringify(state.dealerCodes || []) === JSON.stringify(dealerCodes);

    if (sameScope) {
      return {
        dealerIndex: state.dealerIndex ?? 0,
        reportTypeIndex: state.reportTypeIndex ?? 0,
        rangeIndex: state.rangeIndex ?? 0,
        startDate: START_DATE,
        endDate: END_DATE,
        dealerCodes
      };
    }
  } catch {
    // Fresh run
  }

  return {
    dealerIndex: 0,
    reportTypeIndex: 0,
    rangeIndex: 0,
    startDate: START_DATE,
    endDate: END_DATE,
    dealerCodes
  };
}

async function saveResumeState(state) {
  await fs.mkdir(config.logsDir, { recursive: true });
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify({
      ...state,
      startDate: START_DATE,
      endDate: END_DATE,
      updatedAt: new Date().toISOString()
    }, null, 2)
  );
}

async function checkExistingData() {
  return withPostgresClient(async (client) => {
    const exists = await tableExists(client, TABLE_NAME);
    if (!exists) {
      console.log(`\n❌ Table "${TABLE_NAME}" does NOT exist. Backfill is needed.\n`);
      return { exists: false, rowCount: 0 };
    }

    const countResult = await client.query(
      `SELECT COUNT(*)::int as cnt FROM "${TABLE_NAME}"`
    );
    const totalCount = countResult.rows[0].cnt;
    console.log(`\n✅ Table "${TABLE_NAME}" exists with ${totalCount} rows.`);

    if (totalCount > 0) {
      const dealerResult = await client.query(`
        SELECT source_dealer_code, COUNT(*)::int as cnt,
               MIN(report_period_start) as min_date,
               MAX(report_period_end) as max_date,
               COUNT(DISTINCT report_type) as type_count
        FROM "${TABLE_NAME}"
        GROUP BY source_dealer_code
        ORDER BY source_dealer_code
      `);
      for (const row of dealerResult.rows) {
        console.log(`   ${row.source_dealer_code}: ${row.cnt} rows (${row.min_date} to ${row.max_date}, ${row.type_count} type(s))`);
      }

      const typeResult = await client.query(`
        SELECT report_type, COUNT(*)::int as cnt,
               MIN(report_period_start) as min_date,
               MAX(report_period_end) as max_date
        FROM "${TABLE_NAME}"
        GROUP BY report_type
        ORDER BY report_type
      `);
      for (const row of typeResult.rows) {
        console.log(`   Type "${row.report_type}": ${row.cnt} rows (${row.min_date} to ${row.max_date})`);
      }
    }

    return { exists: true, rowCount: totalCount };
  });
}

// ─── Report extraction functions ────────────────────────────────

async function resolveOperationWiseContext(page) {
  const context = await findContextWithVisibleSelector(page, '#startDate', {
    timeout: 90000,
    label: 'Operation Wise Analysis Report Start Date (AM Platinum)'
  });
  await context.locator('#endDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#reportType').first().waitFor({ state: 'attached', timeout: 30000 });
  await context.locator('#dateType').first().waitFor({ state: 'attached', timeout: 30000 });
  logger.info('AM Platinum Operation Wise Analysis page loaded');
  return context;
}

async function ensureDropdownValue(context, inputId, value) {
  try {
    const widget = context.locator(
      `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]`
    ).first();
    const currentText = await widget.locator('.k-input').first().innerText({ timeout: 5000 })
      .then(text => text.trim())
      .catch(() => '');
    if (currentText === value) {
      logger.info(`Dropdown ${inputId} already set to "${value}"`);
      return;
    }
  } catch {
    // If can't read, just set it
  }
  await selectKendoDropdownByInputId(context, inputId, value);
  await waitForKendoGridIdle(context, { timeout: 120000 });
}

function addReportMetadata(reportType, range, dataset, dealerCode) {
  const metadataHeaders = ['report_type', 'report_month', 'report_period_start', 'report_period_end', 'source_dealer_code'];
  const headers = [
    ...metadataHeaders,
    ...dataset.headers.filter(h => !metadataHeaders.includes(h))
  ];
  const dealerVal = isActiveDealerAlias(dealerCode) ? '' : dealerCode;
  const rows = dataset.rows.map(row => ({
    report_type: reportType,
    report_month: range.reportMonthIso,
    report_period_start: range.startIso,
    report_period_end: range.endIso,
    source_dealer_code: dealerVal || row.dealer_code || row.source_dealer_code || '',
    ...row
  }));
  return { headers, rows };
}

async function ensureOperationWisePagerSize(context) {
  const gridTimeout = 300000;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await selectKendoPagerSizeByVisibleClick(context, PAGE_SIZE, { timeout: 60000 });
    await waitForKendoGridIdle(context, { timeout: gridTimeout });

    const pager = await getPagerState(context, PAGE_SIZE_NUM);
    const appliedSize = pager.selectedPageSize || pager.pageSize;

    if (Number(appliedSize) >= PAGE_SIZE_NUM) {
      logger.info('Operation wise pager size confirmed', {
        pageSize: appliedSize,
        totalItems: pager.totalItems,
        totalPages: pager.totalPages,
        attempt
      });
      return String(appliedSize);
    }

    logger.warn('Pager size 1000 not applied yet; retrying', {
      attempt,
      selectedPageSize: pager.selectedPageSize,
      resolvedPageSize: pager.pageSize,
      visibleRangeSize: pager.visibleRangeSize,
      totalItems: pager.totalItems
    });
    await sleep(2000);
  }

  throw new Error(`Could not apply Kendo pager size ${PAGE_SIZE} after retries`);
}

async function exportForTypeAndRange(context, reportType, range, outputDir, dealerCode) {
  await ensureDropdownValue(context, 'dateType', 'Billing Date');
  await ensureDropdownValue(context, 'reportType', reportType);
  await fillDate(context, '#endDate', range.endPortal);
  await fillDate(context, '#startDate', range.startPortal);

  await clickSearch(context);
  await waitForKendoGridIdle(context, { timeout: 120000 });

  if (config.operationWiseAnalysisPostSearchDelayMs > 0) {
    await sleep(config.operationWiseAnalysisPostSearchDelayMs);
  }

  await ensureOperationWisePagerSize(context);

  const exportDir = path.join(outputDir, sanitizeName(reportType), `${range.startIso}_to_${range.endIso}`);
  const filenameBase = [
    'operation_wise_analysis',
    sanitizeName(reportType),
    range.startIso,
    'to',
    range.endIso
  ].join('_');

  const pageFiles = await exportAllGridPagesToFiles(context, {
    outputDir: exportDir,
    filenameBase,
    pageSize: PAGE_SIZE_NUM,
    maxPages: 500,
    downloadTimeoutMs: 120000
  });

  if (!pageFiles.length) {
    return { rows: [], dbResult: null };
  }

  const merged = await mergeExcelFiles(pageFiles);

  if (!merged.rows.length) {
    await cleanupReportExportDir(exportDir);
    return { rows: [], dbResult: null };
  }

  const dataset = addReportMetadata(reportType, range, merged, dealerCode);

  const dbResult = await saveReportSheetToRelationalTable({
    sheetName: SHEET_NAME,
    headers: dataset.headers,
    rows: dataset.rows
  });

  await cleanupReportExportDir(exportDir);

  return { rows: dataset.rows, dbResult };
}

async function loginSession(account, label = 'AM Platinum DMS login') {
  return retry(
    async () => loginToHmilDms(account),
    {
      attempts: config.loginRetries + 1,
      delayMs: config.retryDelayMs,
      label
    }
  );
}

async function switchToDealer(page, dealerCode, account) {
  if (isActiveDealerAlias(dealerCode)) {
    return;
  }
  await changeActiveDealerForDms(page, dealerCode, {
    homeUrl: account.homeUrl,
    systemLabel: account.systemLabel
  });
}

async function openReportContext(page, dealerCode, account) {
  console.log(`   Opening Operation Wise Analysis Report for ${dealerCode}...`);
  await openAdvWiseLubricantsVasReport(page);
  const context = await resolveOperationWiseContext(page);
  console.log(`   Report page loaded.\n`);
  return context;
}

function isBrowserClosedError(error) {
  return /closed|context|browser|target page/i.test(error?.message || '');
}

function nextResumeIndices(dealerIndex, reportTypeIndex, rangeIndex, dealerCodes, ranges) {
  let nextRange = rangeIndex + 1;
  let nextType = reportTypeIndex;
  let nextDealer = dealerIndex;

  if (nextRange >= ranges.length) {
    nextRange = 0;
    nextType += 1;
    if (nextType >= REPORT_TYPES.length) {
      nextType = 0;
      nextDealer += 1;
    }
  }

  return { dealerIndex: nextDealer, reportTypeIndex: nextType, rangeIndex: nextRange };
}

// ─── Main recovery logic ────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AM Platinum Operation Wise Analysis Recovery Script');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`  Start date: ${START_DATE}`);
  console.log(`  End date: ${END_DATE}`);
  console.log(`  Report types: ${REPORT_TYPES.join(', ')}`);
  console.log(`  Target table: ${TABLE_NAME}`);
  console.log(`  Page size: ${PAGE_SIZE} rows per export page`);
  console.log(`  Post-search delay: ${config.operationWiseAnalysisPostSearchDelayMs}ms`);
  console.log(`  Between-chunk delay: ${config.operationWiseAnalysisBetweenChunksDelayMs}ms\n`);

  console.log('▶ Step 1: Checking if table already has data...');
  const existing = await checkExistingData();

  if (existing.exists && existing.rowCount > 0 && process.env.FORCE_RECOVERY !== 'true') {
    console.log(`\n✅ Table has ${existing.rowCount} rows.`);
    console.log('   Resume is safe (row_hash dedupes overlaps).');
    console.log('   To restart from scratch, set FORCE_RECOVERY=true.\n');
  }

  console.log('\n▶ Step 2: Starting recovery...\n');

  const account = createAccount();
  const dealerCodes = account.dealerCodes.length ? account.dealerCodes : ['active'];
  const ranges = getMonthlySafeRanges(START_DATE, END_DATE);
  const resume = await loadResumeState(dealerCodes);

  console.log(`   Total dealers: ${dealerCodes.join(', ')}`);
  console.log(`   Total months: ${ranges.length} (${START_DATE} to ${END_DATE})`);
  console.log(`   Total iterations: ${ranges.length} months × ${REPORT_TYPES.length} types × ${dealerCodes.length} dealers = ${ranges.length * REPORT_TYPES.length * dealerCodes.length}`);
  if (resume.dealerIndex > 0 || resume.reportTypeIndex > 0 || resume.rangeIndex > 0) {
    console.log(`   Resuming from dealer[${resume.dealerIndex}] type[${resume.reportTypeIndex}] range[${resume.rangeIndex}]`);
  }
  console.log();

  let totalInserted = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  let session = await loginSession(account);
  console.log('   Logged into AM Platinum DMS.\n');

  try {
    for (let dealerIndex = resume.dealerIndex; dealerIndex < dealerCodes.length; dealerIndex++) {
      const dealerCode = dealerCodes[dealerIndex];
      const typeStart = dealerIndex === resume.dealerIndex ? resume.reportTypeIndex : 0;

      console.log(`\n═══════════════════════════════════════════`);
      console.log(`  Processing Dealer: ${dealerCode}`);
      console.log(`═══════════════════════════════════════════\n`);

      await switchToDealer(session.page, dealerCode, account);
      console.log(`   Dealer ${dealerCode} active.`);

      let context = await openReportContext(session.page, dealerCode, account);
      const baseOutputDir = path.join(
        account.reportChunksDir,
        'operation-wise-analysis-recovery',
        sanitizeName(dealerCode)
      );

      for (let reportTypeIndex = typeStart; reportTypeIndex < REPORT_TYPES.length; reportTypeIndex++) {
        const reportType = REPORT_TYPES[reportTypeIndex];
        const rangeStart = dealerIndex === resume.dealerIndex && reportTypeIndex === typeStart
          ? resume.rangeIndex
          : 0;

        console.log(`   ── Report Type: ${reportType} ──`);

        for (let rangeIndex = rangeStart; rangeIndex < ranges.length; rangeIndex++) {
          const range = ranges[rangeIndex];
          const progress = `[${rangeIndex + 1}/${ranges.length}]`;
          const label = `${reportType} ${range.startIso} to ${range.endIso}`;

          process.stdout.write(`     ${progress} ${label}... `);

          let attempt = 0;
          let done = false;

          while (!done && attempt < 2) {
            attempt += 1;
            try {
              const result = await executeWithRetry({
                name: `AM Platinum Operation Wise - ${dealerCode} ${label}`,
                page: session.page,
                fn: async () => exportForTypeAndRange(context, reportType, range, baseOutputDir, dealerCode)
              });

              if (result.rows?.length > 0) {
                const inserted = result.dbResult?.insertedRowCount ?? result.rows.length;
                console.log(`✅ ${inserted} rows`);
                totalInserted += inserted;
              } else {
                console.log(`⚠️  No data`);
                totalSkipped += 1;
              }

              const next = nextResumeIndices(dealerIndex, reportTypeIndex, rangeIndex, dealerCodes, ranges);
              await saveResumeState({
                dealerCodes,
                dealerIndex: next.dealerIndex,
                reportTypeIndex: next.reportTypeIndex,
                rangeIndex: next.rangeIndex,
                lastCompleted: {
                  dealerCode,
                  reportType,
                  rangeStart: range.startIso,
                  rangeEnd: range.endIso
                }
              });

              if (rangeIndex < ranges.length - 1 && config.operationWiseAnalysisBetweenChunksDelayMs > 0) {
                await sleep(config.operationWiseAnalysisBetweenChunksDelayMs);
              }

              done = true;
            } catch (error) {
              if (attempt < 2 && isBrowserClosedError(error)) {
                console.log(`\n     Browser issue detected. Relogging and retrying ${label}...`);
                await session?.close?.().catch(() => {});
                session = await loginSession(account, `AM Platinum re-login for ${dealerCode}`);
                await switchToDealer(session.page, dealerCode, account);
                context = await openReportContext(session.page, dealerCode, account);
                process.stdout.write(`     ${progress} ${label}... `);
                continue;
              }

              console.log(`❌ Failed: ${error.message.slice(0, 120)}`);
              totalFailed += 1;
              done = true;
            }
          }
        }

        console.log();
      }

      console.log(`   ✅ Dealer ${dealerCode} completed.\n`);
    }
  } finally {
    await session?.close?.().catch(() => {});
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Recovery Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total rows inserted: ${totalInserted}`);
  console.log(`  Failed iterations: ${totalFailed}`);
  console.log(`  Skipped (no data): ${totalSkipped}\n`);

  if (totalFailed === 0) {
    await saveResumeState({
      dealerCodes,
      dealerIndex: dealerCodes.length,
      reportTypeIndex: 0,
      rangeIndex: 0,
      status: 'success'
    });
    console.log('✅ All data processed successfully!\n');
  } else {
    console.log(`⚠️  ${totalFailed} iteration(s) failed. Re-run to resume from checkpoint.\n`);
  }

  console.log('▶ Final verification...');
  await checkExistingData();
  console.log('\n✅ Done.');
}

main().catch(error => {
  console.error('\n❌ Recovery script failed:', error);
  process.exit(1);
});
