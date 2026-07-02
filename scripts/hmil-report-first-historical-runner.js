import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import {
  applyHistoricalRunOptions,
  createAmPlatinumAccountForRange,
  describeAmPlatinumLoginPlan,
  normalizeRajouriDealerCode,
  resolveAmPlatinumDealerForFetch,
  resolveAmPlatinumSourceDealerCode,
  resolveAmPlatinumStoredDealerCodesForSkipCheck,
  shouldSkipAmPlatinumRangeForDealer
} from '../src/accounts/am-platinum-accounts.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { getSelectedHmilReports } from '../src/reports/hmil-reports.js';
import { normalizeTableName } from '../src/supabase/relational-store.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';
import {
  formatDateForPortal,
  parseIsoLocalDate,
  toIsoDate
} from '../src/utils/date-range.js';
import { executeWithRetry } from '../src/utils/execute-with-retry.js';
import { currentPageUrl } from '../src/utils/failure.js';
import { logger } from '../src/utils/logger.js';
import { waitForConnectivity } from '../src/utils/network.js';
import { retry } from '../src/utils/retry.js';

const HISTORICAL_REPORT_IDS = [
  'hyundai-repair-order-list',
  'hyundai-ro-billing-report',
  'hyundai-call-center-complaints',
  'hyundai-demo-car-list',
  'hyundai-service-appointment',
  'hyundai-trust-package-bodyshop-sot',
  'hyundai-trust-package-sot-super',
  'hyundai-trust-package-package-list',
  'hyundai-psf-yearly',
  'hyundai-ew-report',
  'hyundai-adv-wise-lubricants-vas',
  'hyundai-operation-wise-analysis-report'
];

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function hasEnv(name) {
  return process.env[name] != null && process.env[name] !== '';
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function envInt(name, fallback = 0) {
  const value = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

function todayIso() {
  return toIsoDate(new Date());
}

function minDate(left, right) {
  return left < right ? left : right;
}

function maxDate(left, right) {
  return left > right ? left : right;
}

function monthKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0')
  ].join('-');
}

function rangeFromDates(startDate, endDate, key) {
  return {
    monthKey: monthKey(startDate),
    rangeKey: key,
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

function getMonthlySafeRanges(startDate, endDate) {
  const ranges = [];
  const finalEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  let monthCursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  while (monthCursor <= finalEnd) {
    const firstOfMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
    const lastOfMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0);
    const monthStart = maxDate(firstOfMonth, startDate);
    const monthEnd = minDate(lastOfMonth, finalEnd);
    ranges.push(rangeFromDates(monthStart, monthEnd, `${monthKey(monthStart)}-1`));

    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
  }

  return ranges;
}

function getMultiMonthlySafeRanges(startDate, endDate, monthsCount) {
  const ranges = [];
  const finalEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  while (cursor <= finalEnd) {
    const chunkStart = maxDate(cursor, startDate);
    const chunkEndTemp = new Date(cursor.getFullYear(), cursor.getMonth() + monthsCount, 0);
    let chunkEnd = minDate(chunkEndTemp, finalEnd);

    // If monthsCount is 3 (Repair Order List), make sure the range never exceeds 90 days
    if (monthsCount === 3) {
      const diffMs = chunkEnd.getTime() - chunkStart.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1;
      if (diffDays > 90) {
        chunkEnd = new Date(chunkStart.getTime());
        chunkEnd.setDate(chunkEnd.getDate() + 89); // chunkStart + 89 days makes exactly 90 days range
      }
    }

    ranges.push(rangeFromDates(chunkStart, chunkEnd, `${monthKey(chunkStart)}-${monthsCount}`));

    cursor = new Date(chunkEnd.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }

  return ranges;
}

function getSafeRangesForReport(reportId, startDate, endDate) {
  if (reportId === 'hyundai-ro-billing-report') {
    return getMultiMonthlySafeRanges(startDate, endDate, 12);
  } else if (reportId === 'hyundai-repair-order-list') {
    return getMultiMonthlySafeRanges(startDate, endDate, 3);
  } else {
    return getMonthlySafeRanges(startDate, endDate);
  }
}

function selectedDealers({ account, envPrefix, accountId = 'hmil' }) {
  const dealers = env(`${envPrefix}_HISTORICAL_DEALERS`, account.dealerCodes.join(','))
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean)
    .map(code => accountId === 'am-platinum' ? normalizeRajouriDealerCode(code) : code);
  return dealers.length ? dealers : ['active'];
}

function selectedReports({ account, envPrefix, historicalReportIds }) {
  const requested = env(`${envPrefix}_HISTORICAL_REPORTS`, historicalReportIds.join(','));
  if (!requested || requested.toLowerCase() === 'scheduled') {
    return getSelectedHmilReports(historicalReportIds.join(','), account);
  }

  if (requested.toLowerCase() === 'all') {
    return getSelectedHmilReports(historicalReportIds.join(','), account);
  }

  return getSelectedHmilReports(requested, account);
}

function isActiveDealerAlias(dealerCode) {
  return !dealerCode || ['active', 'current', 'default'].includes(String(dealerCode).trim().toLowerCase());
}

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
      ) as exists
    `,
    [tableName]
  );

  return Boolean(result.rows[0]?.exists);
}

async function tableColumns(client, tableName) {
  const result = await client.query(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
    `,
    [tableName]
  );

  return new Set(result.rows.map(row => row.column_name));
}

function getHistoricalDateColumnsForReport(reportId) {
  if (reportId === 'hyundai-repair-order-list') {
    return ['r_o_date', 'ro_date'];
  }
  if (reportId === 'hyundai-ro-billing-report') {
    return ['bill_date'];
  }
  return ['report_month', 'report_period_start', 'bill_date', 'ro_date', 'r_o_date'];
}

async function existingDealerReportRangeRowCount({ account, report, dealerCode, startIso, endIso }) {
  const tableName = normalizeTableName(report.sheetName);

  return withPostgresClient(async client => {
    if (!(await tableExists(client, tableName))) {
      return {
        exists: false,
        tableName,
        rowCount: 0,
        dealerColumn: null
      };
    }

    const columns = await tableColumns(client, tableName);
    const dealerColumns = ['source_dealer_code', 'dealer_code'].filter(column => columns.has(column));
    const dateColumns = getHistoricalDateColumnsForReport(report.id).filter(column => columns.has(column));

    if (!dealerColumns.length || !dateColumns.length) {
      logger.warn(`${account.logPrefix} historical range skip check found table without dealer/date columns`, {
        reportId: report.id,
        sheetName: report.sheetName,
        tableName,
        dealerCode,
        startIso,
        endIso,
        dealerColumns,
        dateColumns
      });
      return {
        exists: true,
        tableName,
        rowCount: 0,
        dealerColumn: dealerColumns[0] ?? null,
        dateColumn: dateColumns[0] ?? null
      };
    }

    for (const dealerColumn of dealerColumns) {
      for (const dateColumn of dateColumns) {
        const result = await client.query(
          `
            select count(*)::int as row_count
            from public.${quoteIdentifier(tableName)}
            where upper(trim(${quoteIdentifier(dealerColumn)}::text)) = upper(trim($1::text))
              and ${quoteIdentifier(dateColumn)}::date >= $2::date
              and ${quoteIdentifier(dateColumn)}::date <= $3::date
          `,
          [dealerCode, startIso, endIso]
        );

        const rowCount = Number(result.rows[0]?.row_count ?? 0);
        if (rowCount > 0) {
          return {
            exists: true,
            tableName,
            rowCount,
            dealerColumn,
            dateColumn,
            startIso,
            endIso
          };
        }
      }
    }

    return {
      exists: true,
      tableName,
      rowCount: 0,
      dealerColumn: dealerColumns[0],
      dateColumn: dateColumns[0],
      startIso,
      endIso
    };
  });
}

async function shouldSkipExistingDealerReportRange({ account, report, dealerCode, range, skipExisting }) {
  if (!skipExisting || isActiveDealerAlias(dealerCode)) {
    return {
      skip: false,
      reason: skipExisting ? 'active-dealer-alias' : 'disabled',
      rowCount: 0
    };
  }

  const dealerCodesToCheck = account?.id?.startsWith('am-platinum')
    ? resolveAmPlatinumStoredDealerCodesForSkipCheck(dealerCode, range)
    : [dealerCode];

  let fallback = null;

  for (const code of dealerCodesToCheck) {
    const existing = await existingDealerReportRangeRowCount({
      account,
      report,
      dealerCode: code,
      startIso: range.startIso,
      endIso: range.endIso
    });

    if (!fallback) {
      fallback = existing;
    }

    if (existing.rowCount <= 0) {
      continue;
    }

    logger.info(`${account.logPrefix} historical dealer/report/range already has data; skipping fetch`, {
      reportId: report.id,
      report: report.name,
      sheetName: report.sheetName,
      dealerCode,
      storedDealerCode: code,
      startIso: range.startIso,
      endIso: range.endIso,
      tableName: existing.tableName,
      dealerColumn: existing.dealerColumn,
      dateColumn: existing.dateColumn,
      existingRowCount: existing.rowCount
    });

    return {
      skip: true,
      reason: 'existing-dealer-report-range-data',
      storedDealerCode: code,
      ...existing
    };
  }

  return {
    skip: false,
    reason: fallback?.exists ? 'no-existing-dealer-range-rows' : 'table-missing',
    ...fallback
  };
}

function browserClosedBy(error) {
  const text = `${error?.name ?? ''}\n${error?.message ?? ''}\n${error?.stack ?? ''}`;
  return /target page.*closed|context.*closed|browser.*closed|has been closed/i.test(text);
}

function writeLogLine(logStream, payload) {
  const line = typeof payload === 'string'
    ? payload
    : JSON.stringify({ time: new Date().toISOString(), ...payload });
  process.stdout.write(`${line}\n`);
  logStream.write(`${line}\n`);
}

async function writeJson(filePath, payload) {
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    logger.warn('Failed to read historical resume state; starting from configured indexes', {
      filePath,
      err: serializeError(error)
    });
    return null;
  }
}

async function readResumeState({ stateFile, envPrefix, startIso, endIso, reportIds, dealerCodes }) {
  if (!envBool(`${envPrefix}_HISTORICAL_RESUME_FROM_STATE`, true)) {
    return null;
  }

  const state = await readJsonIfExists(stateFile);
  if (!state || state.status === 'success') {
    return null;
  }

  if (state.startIso !== startIso || state.endIso !== endIso) {
    return null;
  }

  const sameReports = JSON.stringify(state.reportIds ?? []) === JSON.stringify(reportIds);
  const sameDealers = JSON.stringify(state.dealerCodes ?? []) === JSON.stringify(dealerCodes);
  if (!sameReports || !sameDealers) {
    return null;
  }

  const nextDealerIndex = Number.isInteger(state.nextDealerIndex)
    ? state.nextDealerIndex
    : state.startDealerIndex;
  const nextReportIndex = Number.isInteger(state.nextReportIndex)
    ? state.nextReportIndex
    : state.startReportIndex;
  const nextRangeIndex = Number.isInteger(state.nextRangeIndex)
    ? state.nextRangeIndex
    : state.startRangeIndex;
  const hasResumeIndexes = Number.isInteger(nextDealerIndex)
    && Number.isInteger(nextReportIndex)
    && Number.isInteger(nextRangeIndex);

  return hasResumeIndexes
    ? {
        ...state,
        nextDealerIndex,
        nextReportIndex,
        nextRangeIndex
      }
    : null;
}

async function writeHealthStatus(account, status) {
  const payload = {
    service: account.serviceName,
    accountId: account.id,
    brand: account.brand,
    env: process.env.NODE_ENV || 'development',
    updatedAt: new Date().toISOString(),
    ...status
  };
  const filePath = path.join(config.logsDir, account.healthFileName);
  await writeJson(filePath, payload);
  logger.info(`${account.logPrefix} historical health status updated`, {
    status: payload.status,
    filePath
  });
}

async function loginForDealer(account, dealerCode) {
  const session = await retry(
    async () => loginToHmilDms(account),
    {
      attempts: config.loginRetries + 1,
      delayMs: config.retryDelayMs,
      label: `${account.logPrefix} report-first historical DMS login`
    }
  );

  if (!isActiveDealerAlias(dealerCode)) {
    await changeActiveDealerForDms(session.page, dealerCode, {
      homeUrl: account.homeUrl,
      systemLabel: account.systemLabel
    });
  }

  return session;
}

async function ensureAmPlatinumSessionForRange({
  session,
  activeAccountKey,
  activeAccount,
  activeDealerCode,
  dealerCode,
  range,
  serviceName
}) {
  const { accountKey, account: rangeAccount } = createAmPlatinumAccountForRange(range, dealerCode);
  const fetchDealerCode = resolveAmPlatinumDealerForFetch(dealerCode, range);
  const fullAccount = {
    ...applyHistoricalRunOptions(rangeAccount),
    serviceName
  };
  const accountChanged = !session || activeAccountKey !== accountKey;
  const dealerChanged = activeDealerCode !== fetchDealerCode;

  if (!accountChanged && !dealerChanged && session) {
    return {
      session,
      activeAccountKey: accountKey,
      activeAccount: fullAccount,
      activeDealerCode: fetchDealerCode,
      accountSwitched: false
    };
  }

  if (accountChanged) {
    await session?.close?.().catch(() => {});
    logger.info(`${fullAccount.logPrefix} historical login for range`, {
      userId: fullAccount.userId,
      startIso: range.startIso,
      endIso: range.endIso,
      fetchDealerCode,
      storeDealerCode: resolveAmPlatinumSourceDealerCode(dealerCode, range)
    });
    session = await loginForDealer(fullAccount, fetchDealerCode);
  } else if (!isActiveDealerAlias(fetchDealerCode)) {
    await changeActiveDealerForDms(session.page, fetchDealerCode, {
      homeUrl: fullAccount.homeUrl,
      systemLabel: fullAccount.systemLabel
    });
  }

  return {
    session,
    activeAccountKey: accountKey,
    activeAccount: fullAccount,
    activeDealerCode: fetchDealerCode,
    accountSwitched: accountChanged
  };
}

async function runHistoricalReportRange({
  page,
  account,
  report,
  dealerCode,
  range,
  skipNavigation = false,
  pageSize = '1000'
}) {
  const label = `${report.name} [${dealerCode}] ${range.startIso} to ${range.endIso}`;
  const startedAt = Date.now();

  try {
    const result = await executeWithRetry({
      name: label,
      page,
      fn: () => report.run(page, {
        dealerCode,
        account,
        range,
        skipNavigation,
        pageSize,
        reportNameOverride: report.name,
        sheetNameOverride: report.sheetName
      })
    });

    return {
      status: 'success',
      reportId: report.id,
      report: report.name,
      dealerCode,
      sheetName: result.sheetName,
      dbAction: result.dbResult?.action,
      rowCount: result.dbResult?.rowCount,
      failedLoopCount: result.dbResult?.failedLoopCount ?? 0,
      failedLoops: result.dbResult?.failedLoops ?? [],
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const currentUrl = await currentPageUrl(page);
    logger.error(`${account.logPrefix} report-first historical range failed after retries; continuing`, {
      reportId: report.id,
      report: report.name,
      dealerCode,
      range: `${range.startIso} to ${range.endIso}`,
      durationMs: Date.now() - startedAt,
      currentUrl,
      err: serializeError(error)
    });

    return {
      status: 'failed',
      reportId: report.id,
      report: report.name,
      dealerCode,
      phase: 'report-range',
      durationMs: Date.now() - startedAt,
      currentUrl,
      browserClosed: browserClosedBy(error),
      error: serializeError(error)
    };
  }
}

async function runOptimizedHistoricalReportRange({
  page,
  account,
  report,
  dealerCode,
  range,
  skipNavigation = false,
  pageSize = '1000',
  maxPages
}) {
  const label = `${report.name} [${dealerCode}] optimized ${range.startIso} to ${range.endIso}`;
  const startedAt = Date.now();

  try {
    const result = await executeWithRetry({
      name: label,
      page,
      fn: () => report.run(page, {
        dealerCode,
        account,
        range,
        skipNavigation,
        optimizedNoSearch: true,
        pageSize,
        maxPages,
        reportNameOverride: report.name,
        sheetNameOverride: report.sheetName
      })
    });

    return {
      status: 'success',
      reportId: report.id,
      report: report.name,
      dealerCode,
      sheetName: result.sheetName,
      dbAction: result.dbResult?.action,
      rowCount: result.dbResult?.rowCount,
      failedLoopCount: result.dbResult?.failedLoopCount ?? 0,
      failedLoops: result.dbResult?.failedLoops ?? [],
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const currentUrl = await currentPageUrl(page);
    logger.error(`${account.logPrefix} optimized report-first historical range failed after retries; continuing`, {
      reportId: report.id,
      report: report.name,
      dealerCode,
      range: `${range.startIso} to ${range.endIso}`,
      durationMs: Date.now() - startedAt,
      currentUrl,
      err: serializeError(error)
    });

    return {
      status: 'failed',
      reportId: report.id,
      report: report.name,
      dealerCode,
      phase: 'optimized-report-range',
      durationMs: Date.now() - startedAt,
      currentUrl,
      browserClosed: browserClosedBy(error),
      error: serializeError(error)
    };
  }
}

function summarizeResult({ dealerCode, dealerIndex, report, reportIndex, range, rangeIndex, result }) {
  return {
    dealerCode,
    dealerIndex,
    reportId: report.id,
    report: report.name,
    reportIndex,
    rangeIndex,
    monthKey: range.monthKey,
    rangeKey: range.rangeKey,
    startIso: range.startIso,
    endIso: range.endIso,
    exitCode: result.status === 'failed' ? 1 : 0,
    status: result.status,
    dbAction: result.dbAction,
    rowCount: result.rowCount,
    failedLoopCount: result.failedLoopCount ?? 0,
    failedLoops: result.failedLoops ?? [],
    error: result.error,
    currentUrl: result.currentUrl,
    durationMs: result.durationMs
  };
}

export async function runGdmsReportFirstHistoricalBackfill({
  accountId = 'hmil',
  envPrefix = 'HMIL',
  stateFileName = 'hmil-historical-backfill-state.json',
  logFilePrefix = 'hmil-historical-backfill',
  serviceName = 'hmil-historical-backfill',
  defaultStartDate = '2021-01-01',
  defaultHeadless = false,
  historicalReportIds = HISTORICAL_REPORT_IDS,
  optimizedFullRangeNoSearch = false,
  customizeAccount = account => account,
  customizeReports = reports => reports
} = {}) {
  await fsp.mkdir(config.logsDir, { recursive: true });

  const baseAccount = createGdmsAccountProfile(accountId);
  const configuredAccount = {
    ...baseAccount,
    forceLogin: envBool(`${envPrefix}_HISTORICAL_FORCE_LOGIN`, baseAccount.forceLogin),
    headless: envBool(`${envPrefix}_HISTORICAL_HEADLESS`, defaultHeadless),
    otpProvider: env(
      `${envPrefix}_HISTORICAL_OTP_PROVIDER`,
      accountId === 'am-platinum' ? config.amPlatinumHistoricalOtpProvider : 'manual'
    ),
    serviceName
  };
  const account = customizeAccount(configuredAccount) ?? configuredAccount;
  const reports = customizeReports(selectedReports({ account, envPrefix, historicalReportIds })) ??
    selectedReports({ account, envPrefix, historicalReportIds });
  const reportIds = reports.map(report => report.id);
  const dealerCodes = selectedDealers({ account, envPrefix, accountId });
  const startIso = env(`${envPrefix}_HISTORICAL_START_DATE`, defaultStartDate);
  const endIso = env(`${envPrefix}_HISTORICAL_END_DATE`, todayIso());
  const ranges = optimizedFullRangeNoSearch
    ? [rangeFromDates(parseIsoLocalDate(startIso), parseIsoLocalDate(endIso), 'full-range')]
    : getMonthlySafeRanges(parseIsoLocalDate(startIso), parseIsoLocalDate(endIso));
  const optimizedPageSize = env(`${envPrefix}_HISTORICAL_PAGE_SIZE`, '1000');
  const optimizedMaxPages = Number.parseInt(env(`${envPrefix}_HISTORICAL_MAX_PAGES`, ''), 10);
  const skipExistingDealerReports = envBool(`${envPrefix}_HISTORICAL_SKIP_EXISTING`, optimizedFullRangeNoSearch);
  const stateFile = path.join(config.logsDir, stateFileName);
  const resumeState = optimizedFullRangeNoSearch
    ? null
    : await readResumeState({
        stateFile,
        envPrefix,
        startIso,
        endIso,
        reportIds,
        dealerCodes
      });
  const startDealerIndex = hasEnv(`${envPrefix}_HISTORICAL_START_DEALER_INDEX`)
    ? envInt(`${envPrefix}_HISTORICAL_START_DEALER_INDEX`, 0)
    : resumeState?.nextDealerIndex ?? 0;
  const startReportIndex = hasEnv(`${envPrefix}_HISTORICAL_START_REPORT_INDEX`)
    ? envInt(`${envPrefix}_HISTORICAL_START_REPORT_INDEX`, 0)
    : resumeState?.nextReportIndex ?? 0;
  const rangeIndexEnvName = hasEnv(`${envPrefix}_HISTORICAL_START_RANGE_INDEX`)
    ? `${envPrefix}_HISTORICAL_START_RANGE_INDEX`
    : `${envPrefix}_HISTORICAL_START_CHUNK_INDEX`;
  const startRangeIndex = hasEnv(rangeIndexEnvName)
    ? envInt(rangeIndexEnvName, 0)
    : resumeState?.nextRangeIndex ?? 0;
  const maxDealers = Number.parseInt(env(`${envPrefix}_HISTORICAL_MAX_DEALERS`, ''), 10);
  const maxReports = Number.parseInt(env(`${envPrefix}_HISTORICAL_MAX_REPORTS`, ''), 10);
  const maxRanges = Number.parseInt(
    env(`${envPrefix}_HISTORICAL_MAX_RANGES`, env(`${envPrefix}_HISTORICAL_MAX_CHUNKS`, '')),
    10
  );
  const stopOnFailure = envBool(`${envPrefix}_HISTORICAL_STOP_ON_FAILURE`, false);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(config.logsDir, `${logFilePrefix}-${runId}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const results = [];
  const selectedDealersForRun = Number.isFinite(maxDealers)
    ? dealerCodes.slice(startDealerIndex, startDealerIndex + maxDealers)
    : dealerCodes.slice(startDealerIndex);
  const startedAt = new Date();

  const initialState = {
    status: 'running',
    startedAt: startedAt.toISOString(),
    strategy: optimizedFullRangeNoSearch
      ? 'dealer-report-full-range-start-date-only-no-search'
      : 'dealer-report-range-monthly-safe-single-session',
    startIso,
    endIso,
    totalRanges: ranges.length,
    startDealerIndex,
    startReportIndex,
    startRangeIndex,
    selectedDealerCount: selectedDealersForRun.length,
    reportIds,
    dealerCodes,
    headless: account.headless,
    optimizedFullRangeNoSearch,
    optimizedPageSize: optimizedFullRangeNoSearch ? optimizedPageSize : null,
    skipExistingDealerReports,
    resumedFromState: Boolean(resumeState),
    resumeStateUpdatedAt: resumeState?.updatedAt ?? null,
    amPlatinumHistoricalUserId: accountId === 'am-platinum' ? config.amPlatinumHistoricalUserId : null,
    amPlatinumCurrentUserId: accountId === 'am-platinum' ? config.amPlatinumUserId : null,
    amPlatinumHistoricalCutoffDate: accountId === 'am-platinum' ? config.amPlatinumHistoricalCutoffDate : null,
    logFile
  };
  await writeJson(stateFile, initialState);
  if (accountId === 'am-platinum') {
    logger.info(describeAmPlatinumLoginPlan(startIso, endIso, dealerCodes));
  }
  await writeHealthStatus(account, {
    status: 'running',
    mode: reportIds.join(','),
    dealerCodes: selectedDealersForRun,
    startedAt: startedAt.toISOString(),
    headless: account.headless
  });

  try {
    await waitForConnectivity({ label: `${account.logPrefix} report-first historical startup` });

    for (const dealerCode of selectedDealersForRun) {
      const dealerIndex = dealerCodes.indexOf(dealerCode);
      const dealerReportOffset = dealerIndex === startDealerIndex ? startReportIndex : 0;
      const selectedReportsForDealer = Number.isFinite(maxReports)
        ? reports.slice(dealerReportOffset, dealerReportOffset + maxReports)
        : reports.slice(dealerReportOffset);
      let session = null;
      let activeAccountKey = null;
      let activeAccount = account;
      let activeDealerCode = null;

      try {
        writeLogLine(logStream, {
          event: 'dealer_started',
          accountId: account.id,
          dealerCode,
          reportCount: selectedReportsForDealer.length,
          totalRanges: ranges.length
        });

        if (accountId !== 'am-platinum') {
          session = await loginForDealer(account, dealerCode);
          activeDealerCode = dealerCode;
        }

        for (const report of selectedReportsForDealer) {
          let openReportId = null;
          const reportIndex = reports.findIndex(candidate => candidate.id === report.id);
          const reportRangeOffset = dealerIndex === startDealerIndex && reportIndex === startReportIndex
            ? startRangeIndex
            : 0;
          const reportRanges = optimizedFullRangeNoSearch
            ? [rangeFromDates(parseIsoLocalDate(startIso), parseIsoLocalDate(endIso), 'full-range')]
            : getSafeRangesForReport(report.id, parseIsoLocalDate(startIso), parseIsoLocalDate(endIso));
          const selectedRanges = Number.isFinite(maxRanges)
            ? reportRanges.slice(reportRangeOffset, reportRangeOffset + maxRanges)
            : reportRanges.slice(reportRangeOffset);

          writeLogLine(logStream, {
            event: 'report_started',
            dealerCode,
            reportId: report.id,
            report: report.name,
            reportIndex,
            rangeCount: selectedRanges.length
          });

          for (const range of selectedRanges) {
            const rangeIndex = reportRanges.indexOf(range);
            try {
              if (accountId === 'am-platinum' && shouldSkipAmPlatinumRangeForDealer(dealerCode, range)) {
                const summary = summarizeResult({
                  dealerCode,
                  dealerIndex,
                  report,
                  reportIndex,
                  range,
                  rangeIndex,
                  result: {
                    status: 'skipped',
                    dbAction: 'skipped_post_2024_not_on_current_login',
                    rowCount: 0,
                    durationMs: 0
                  }
                });
                summary.reason = 'post-2024-not-on-current-login';
                results.push(summary);

                writeLogLine(logStream, {
                  event: 'range_skipped_post_2024_not_on_current_login',
                  dealerCode,
                  reportId: report.id,
                  report: report.name,
                  rangeIndex,
                  startIso: range.startIso,
                  endIso: range.endIso
                });
                continue;
              }

              const existingRangeCheck = await shouldSkipExistingDealerReportRange({
                account,
                report,
                dealerCode,
                range,
                skipExisting: skipExistingDealerReports
              });

              if (existingRangeCheck.skip) {
                const summary = summarizeResult({
                  dealerCode,
                  dealerIndex,
                  report,
                  reportIndex,
                  range,
                  rangeIndex,
                  result: {
                    status: 'skipped',
                    dbAction: 'skipped_existing_dealer_report_range_data',
                    rowCount: existingRangeCheck.rowCount,
                    durationMs: 0
                  }
                });
                summary.tableName = existingRangeCheck.tableName;
                summary.dealerColumn = existingRangeCheck.dealerColumn;
                summary.dateColumn = existingRangeCheck.dateColumn;
                summary.reason = existingRangeCheck.reason;
                results.push(summary);

                await writeJson(stateFile, {
                  ...initialState,
                  status: 'running',
                  updatedAt: new Date().toISOString(),
                  currentDealerCode: dealerCode,
                  currentDealerIndex: dealerIndex,
                  currentReportId: report.id,
                  currentReportIndex: reportIndex,
                  currentRangeIndex: rangeIndex,
                  lastCompletedReportId: report.id,
                  lastCompletedRangeIndex: rangeIndex,
                  nextDealerIndex: rangeIndex + 1 >= reportRanges.length && reportIndex + 1 >= reports.length
                    ? dealerIndex + 1
                    : dealerIndex,
                  nextReportIndex: rangeIndex + 1 >= reportRanges.length ? reportIndex + 1 : reportIndex,
                  nextRangeIndex: rangeIndex + 1 >= reportRanges.length ? 0 : rangeIndex + 1,
                  completedWorkItemCount: results.length,
                  latestResult: summary
                });

                writeLogLine(logStream, {
                  event: 'range_skipped_existing_data',
                  dealerCode,
                  reportId: report.id,
                  report: report.name,
                  rangeIndex,
                  startIso: range.startIso,
                  endIso: range.endIso,
                  tableName: existingRangeCheck.tableName,
                  dealerColumn: existingRangeCheck.dealerColumn,
                  dateColumn: existingRangeCheck.dateColumn,
                  existingRowCount: existingRangeCheck.rowCount
                });
                continue;
              }

              const currentState = {
                ...initialState,
                updatedAt: new Date().toISOString(),
                currentDealerCode: dealerCode,
                currentDealerIndex: dealerIndex,
                currentReportId: report.id,
                currentReportIndex: reportIndex,
                currentRangeIndex: rangeIndex,
                lastCompletedReportId: results.at(-1)?.reportId ?? null,
                lastCompletedRangeIndex: results.at(-1)?.rangeIndex ?? null,
                nextDealerIndex: dealerIndex,
                nextReportIndex: reportIndex,
                nextRangeIndex: rangeIndex,
                completedWorkItemCount: results.length,
                latestResult: results.at(-1) ?? null
              };
              await writeJson(stateFile, currentState);
              writeLogLine(logStream, {
                event: 'range_started',
                dealerCode,
                reportId: report.id,
                rangeIndex,
                startIso: range.startIso,
                endIso: range.endIso
              });

              let rangeAccount = account;
              if (accountId === 'am-platinum') {
                const ensured = await ensureAmPlatinumSessionForRange({
                  session,
                  activeAccountKey,
                  activeAccount,
                  activeDealerCode,
                  dealerCode,
                  range,
                  serviceName
                });
                session = ensured.session;
                activeAccountKey = ensured.activeAccountKey;
                activeAccount = ensured.activeAccount;
                activeDealerCode = ensured.activeDealerCode;
                rangeAccount = ensured.activeAccount;
                if (ensured.accountSwitched) {
                  openReportId = null;
                }

                writeLogLine(logStream, {
                  event: 'am_platinum_login_selected',
                  dealerCode,
                  reportId: report.id,
                  rangeIndex,
                  userId: rangeAccount.userId,
                  startIso: range.startIso,
                  endIso: range.endIso
                });
              } else if (!session) {
                logger.info(`${account.logPrefix} Session was closed/null; recreating session for ${dealerCode}`);
                session = await loginForDealer(account, dealerCode);
                openReportId = null;
              }

              const storedDealerCode = accountId === 'am-platinum'
                ? resolveAmPlatinumSourceDealerCode(dealerCode, range)
                : dealerCode;

              const result = optimizedFullRangeNoSearch
                ? await runOptimizedHistoricalReportRange({
                    page: session.page,
                    account: rangeAccount,
                    report,
                    dealerCode: storedDealerCode,
                    range,
                    skipNavigation: openReportId === report.id,
                    pageSize: optimizedPageSize,
                    maxPages: Number.isFinite(optimizedMaxPages) ? optimizedMaxPages : undefined
                  })
                : await runHistoricalReportRange({
                    page: session.page,
                    account: rangeAccount,
                  report,
                  dealerCode: storedDealerCode,
                  range,
                  skipNavigation: openReportId === report.id,
                  pageSize: optimizedPageSize
                });
              const summary = summarizeResult({
                dealerCode,
                dealerIndex,
                report,
                reportIndex,
                range,
                rangeIndex,
                result
              });
              results.push(summary);

              const failed = result.status === 'failed';
              const completedReportRanges = rangeIndex + 1 >= reportRanges.length;
              const nextReportIndex = failed
                ? reportIndex
                : completedReportRanges ? reportIndex + 1 : reportIndex;
              const nextDealerIndex = failed
                ? dealerIndex
                : nextReportIndex >= reports.length ? dealerIndex + 1 : dealerIndex;
              const nextRangeIndex = failed
                ? rangeIndex
                : completedReportRanges ? 0 : rangeIndex + 1;
              const state = {
                ...initialState,
                status: failed ? 'failed_at_current_range' : 'running',
                updatedAt: new Date().toISOString(),
                currentDealerCode: dealerCode,
                currentDealerIndex: dealerIndex,
                currentReportId: report.id,
                currentReportIndex: reportIndex,
                currentRangeIndex: rangeIndex,
                lastCompletedReportId: report.id,
                lastCompletedRangeIndex: rangeIndex,
                nextDealerIndex,
                nextReportIndex,
                nextRangeIndex,
                completedWorkItemCount: results.length,
                latestResult: summary
              };
              await writeJson(stateFile, state);
              await writeHealthStatus(account, {
                status: failed ? 'completed_with_failures' : 'success',
                mode: reportIds.join(','),
                dealerCodes: [dealerCode],
                startedAt: startedAt.toISOString(),
                completedAt: new Date().toISOString(),
                range: {
                  rangeIndex,
                  startIso: range.startIso,
                  endIso: range.endIso
                },
                reports: [result],
                failedReports: failed ? [result] : []
              });
              writeLogLine(logStream, {
                event: 'range_completed',
                dealerCode,
                reportId: report.id,
                rangeIndex,
                startIso: range.startIso,
                endIso: range.endIso,
                status: result.status,
                rowCount: result.rowCount,
                dbAction: result.dbAction
              });

              if (failed && stopOnFailure) {
                throw new Error(`${account.logPrefix} report-first historical stopped at failed range for resume: ${dealerCode} ${report.id} ${range.startIso} to ${range.endIso}`);
              }

              if (result.browserClosed) {
                openReportId = null;
                logger.warn(`${rangeAccount.logPrefix} report-first historical browser closed; relogging for same dealer`, {
                  dealerCode,
                  reportId: report.id,
                  range: `${range.startIso} to ${range.endIso}`
                });
                await session?.close?.().catch(() => {});
                session = null;
                activeAccountKey = null;
                if (accountId === 'am-platinum') {
                  const ensured = await ensureAmPlatinumSessionForRange({
                    session,
                    activeAccountKey,
                    activeAccount,
                    activeDealerCode,
                    dealerCode,
                    range,
                    serviceName
                  });
                  session = ensured.session;
                  activeAccountKey = ensured.activeAccountKey;
                  activeAccount = ensured.activeAccount;
                  activeDealerCode = ensured.activeDealerCode;
                } else {
                  session = await loginForDealer(account, dealerCode);
                }
              } else {
                openReportId = report.id;
              }
            } catch (err) {
              logger.error(`${account.logPrefix} Unexpected error in range loop for ${dealerCode} ${report.id} range ${rangeIndex}:`, err);
              const summary = {
                dealerCode,
                dealerIndex,
                reportId: report.id,
                report: report.name,
                rangeIndex,
                startIso: range.startIso,
                endIso: range.endIso,
                status: 'failed',
                error: serializeError(err)
              };
              results.push(summary);

              const state = {
                ...initialState,
                status: 'failed_at_current_range',
                updatedAt: new Date().toISOString(),
                currentDealerCode: dealerCode,
                currentDealerIndex: dealerIndex,
                currentReportId: report.id,
                currentReportIndex: reportIndex,
                currentRangeIndex: rangeIndex,
                lastCompletedReportId: report.id,
                lastCompletedRangeIndex: rangeIndex,
                nextDealerIndex: dealerIndex,
                nextReportIndex: reportIndex,
                nextRangeIndex: rangeIndex,
                completedWorkItemCount: results.length,
                latestResult: summary
              };
              await writeJson(stateFile, state);

              await writeHealthStatus(account, {
                status: 'completed_with_failures',
                mode: reportIds.join(','),
                dealerCodes: [dealerCode],
                startedAt: startedAt.toISOString(),
                completedAt: new Date().toISOString(),
                range: {
                  rangeIndex,
                  startIso: range.startIso,
                  endIso: range.endIso
                },
                reports: [summary],
                failedReports: [summary]
              });

              writeLogLine(logStream, {
                event: 'range_completed',
                dealerCode,
                reportId: report.id,
                rangeIndex,
                startIso: range.startIso,
                endIso: range.endIso,
                status: 'failed',
                rowCount: 0,
                dbAction: 'error',
                error: err.message
              });

              if (stopOnFailure) {
                throw err;
              }

              if (session) {
                await session.close?.().catch(() => {});
                session = null;
              }
              activeAccountKey = null;
              openReportId = null;
            }
          }

          writeLogLine(logStream, {
            event: 'report_completed',
            dealerCode,
            reportId: report.id,
            report: report.name
          });
        }
      } finally {
        await session?.close?.().catch(() => {});
        writeLogLine(logStream, {
          event: 'dealer_completed',
          accountId: account.id,
          dealerCode
        });
      }
    }

    const failedResults = results.filter(result => result.status === 'failed');
    const finalState = {
      ...initialState,
      status: failedResults.length ? 'completed_with_failures' : 'success',
      completedAt: new Date().toISOString(),
      completedWorkItemCount: results.length,
      failedWorkItemCount: failedResults.length,
      results
    };
    await writeJson(stateFile, finalState);
    await writeHealthStatus(account, {
      status: finalState.status,
      mode: reportIds.join(','),
      dealerCodes: selectedDealersForRun,
      startedAt: startedAt.toISOString(),
      completedAt: finalState.completedAt,
      reports: results,
      failedReports: failedResults
    });
  } catch (error) {
    try {
      const currentState = await readJsonIfExists(stateFile) || initialState;
      const failedState = {
        ...currentState,
        status: 'failed',
        error: serializeError(error),
        updatedAt: new Date().toISOString()
      };
      await writeJson(stateFile, failedState);
    } catch (writeError) {
      logger.error(`${account.logPrefix} failed to write failure state to ${stateFileName}:`, writeError);
    }
    throw error;
  } finally {
    logStream.end();
  }
}

export async function runHmilReportFirstHistoricalBackfill() {
  await runGdmsReportFirstHistoricalBackfill();
}
