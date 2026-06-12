import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { createHmilReportDefinitions } from '../src/reports/hmil-reports.js';
import {
  addDays,
  formatDateForPortal,
  parseIsoLocalDate,
  toIsoDate
} from '../src/utils/date-range.js';
import { executeWithRetry } from '../src/utils/execute-with-retry.js';
import { currentPageUrl } from '../src/utils/failure.js';
import { logger } from '../src/utils/logger.js';
import { waitForConnectivity } from '../src/utils/network.js';
import { retry } from '../src/utils/retry.js';

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
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
    let currentStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), monthStart.getDate());
    let part = 1;

    while (currentStart <= monthEnd) {
      const currentEnd = minDate(addDays(currentStart, 29), monthEnd);
      ranges.push(rangeFromDates(currentStart, currentEnd, `${monthKey(currentStart)}-${part}`));
      currentStart = addDays(currentEnd, 1);
      part += 1;
    }

    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
  }

  return ranges;
}

function selectedReports({ envPrefix, reportDefinitions }) {
  const requested = env(`${envPrefix}_HISTORICAL_REPORTS`, 'all').trim();
  if (!requested || requested.toLowerCase() === 'all') {
    return reportDefinitions;
  }

  const requestedIds = requested
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const known = new Set(reportDefinitions.map(report => report.id));
  const unknown = requestedIds.filter(id => !known.has(id));
  if (unknown.length) {
    throw new Error(`Unknown ${envPrefix} historical report id(s): ${unknown.join(', ')}`);
  }

  return reportDefinitions.filter(report => requestedIds.includes(report.id));
}

function selectedDealers({ envPrefix, account }) {
  const dealers = env(`${envPrefix}_HISTORICAL_DEALERS`, account.dealerCodes.join(','))
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
  return dealers.length ? dealers : ['active'];
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
      label: `${account.logPrefix} historical DMS login`
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

async function runHistoricalReport({ page, account, report, dealerCode, range }) {
  const label = `${report.name} [${dealerCode}] ${range.startIso} to ${range.endIso}`;
  const startedAt = Date.now();

  try {
    const result = await executeWithRetry({
      name: label,
      page,
      fn: () => report.run(page, { dealerCode, account, range })
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
    logger.error(`${account.logPrefix} historical report failed after retries; continuing`, {
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
      phase: 'report',
      durationMs: Date.now() - startedAt,
      currentUrl,
      browserClosed: browserClosedBy(error),
      error: serializeError(error)
    };
  }
}

function summarizeRange({ dealerCode, dealerIndex, range, rangeIndex, reportResults }) {
  const failedReports = reportResults.filter(report => report.status === 'failed');
  const failedLoops = reportResults.flatMap(report =>
    (report.failedLoops ?? []).map(loop => ({
      reportId: report.reportId,
      report: report.report,
      dealerCode: report.dealerCode,
      loopValue: loop.loopValue,
      message: loop.message,
      screenshotPath: loop.screenshotPath
    }))
  );

  return {
    dealerCode,
    dealerIndex,
    rangeIndex,
    monthKey: range.monthKey,
    rangeKey: range.rangeKey,
    startIso: range.startIso,
    endIso: range.endIso,
    exitCode: failedReports.length ? 1 : 0,
    status: failedReports.length ? 'completed_with_failures' : 'success',
    failedReportCount: failedReports.length,
    successCount: reportResults.filter(report => report.status === 'success').length,
    failureCount: failedReports.length,
    reportSummaries: reportResults.map(report => ({
      reportId: report.reportId,
      report: report.report,
      dealerCode: report.dealerCode,
      status: report.status,
      dbAction: report.dbAction,
      rowCount: report.rowCount,
      failedLoopCount: report.failedLoopCount ?? 0
    })),
    failedReports: failedReports.map(report => ({
      reportId: report.reportId,
      report: report.report,
      dealerCode: report.dealerCode,
      phase: report.phase,
      error: report.error?.message
    })),
    failedLoops
  };
}

export async function runGdmsHistoricalBackfill({
  accountId,
  envPrefix,
  stateFileName,
  logFilePrefix,
  defaultStartDate = '2021-01-01'
}) {
  await fsp.mkdir(config.logsDir, { recursive: true });

  const baseAccount = createGdmsAccountProfile(accountId);
  const account = {
    ...baseAccount,
    forceLogin: env(`${envPrefix}_HISTORICAL_FORCE_LOGIN`, String(baseAccount.forceLogin)).toLowerCase() === 'true'
  };
  const reportDefinitions = createHmilReportDefinitions(account);
  const reports = selectedReports({ envPrefix, reportDefinitions });
  const reportIds = reports.map(report => report.id);
  const dealerCodes = selectedDealers({ envPrefix, account });
  const startIso = env(`${envPrefix}_HISTORICAL_START_DATE`, defaultStartDate);
  const endIso = env(`${envPrefix}_HISTORICAL_END_DATE`, todayIso());
  const ranges = getMonthlySafeRanges(parseIsoLocalDate(startIso), parseIsoLocalDate(endIso));
  const startDealerIndex = Number.parseInt(env(`${envPrefix}_HISTORICAL_START_DEALER_INDEX`, '0'), 10) || 0;
  const startRangeIndex = Number.parseInt(
    env(`${envPrefix}_HISTORICAL_START_RANGE_INDEX`, env(`${envPrefix}_HISTORICAL_START_CHUNK_INDEX`, '0')),
    10
  ) || 0;
  const maxDealers = Number.parseInt(env(`${envPrefix}_HISTORICAL_MAX_DEALERS`, ''), 10);
  const maxRanges = Number.parseInt(
    env(`${envPrefix}_HISTORICAL_MAX_RANGES`, env(`${envPrefix}_HISTORICAL_MAX_CHUNKS`, '')),
    10
  );
  const stopOnFailure = env(`${envPrefix}_HISTORICAL_STOP_ON_FAILURE`, 'false').toLowerCase() === 'true';
  const stateFile = path.join(config.logsDir, stateFileName);
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
    strategy: 'dealer-first-monthly-safe-single-session',
    startIso,
    endIso,
    totalRanges: ranges.length,
    startDealerIndex,
    startRangeIndex,
    selectedDealerCount: selectedDealersForRun.length,
    reportIds,
    dealerCodes,
    logFile
  };
  await writeJson(stateFile, initialState);
  await writeHealthStatus(account, {
    status: 'running',
    mode: reportIds.join(','),
    dealerCodes: selectedDealersForRun,
    startedAt: startedAt.toISOString()
  });

  try {
    await waitForConnectivity({ label: `${account.logPrefix} historical startup` });

    for (const dealerCode of selectedDealersForRun) {
      const dealerIndex = dealerCodes.indexOf(dealerCode);
      const rangeOffset = dealerIndex === startDealerIndex ? startRangeIndex : 0;
      const selectedRanges = Number.isFinite(maxRanges)
        ? ranges.slice(rangeOffset, rangeOffset + maxRanges)
        : ranges.slice(rangeOffset);
      let session = null;

      try {
        writeLogLine(logStream, {
          event: 'dealer_started',
          accountId: account.id,
          dealerCode,
          rangeCount: selectedRanges.length
        });
        session = await loginForDealer(account, dealerCode);

        for (const range of selectedRanges) {
          const rangeIndex = ranges.indexOf(range);
          const reportResults = [];

          writeLogLine(logStream, {
            event: 'range_started',
            dealerCode,
            rangeIndex,
            totalRanges: ranges.length,
            startIso: range.startIso,
            endIso: range.endIso,
            reportCount: reports.length
          });

          for (const report of reports) {
            const currentState = {
              ...initialState,
              updatedAt: new Date().toISOString(),
              currentDealerCode: dealerCode,
              currentDealerIndex: dealerIndex,
              currentRangeIndex: rangeIndex,
              currentReportId: report.id,
              lastCompletedRangeIndex: results.at(-1)?.rangeIndex ?? null,
              nextDealerIndex: dealerIndex,
              nextRangeIndex: rangeIndex,
              completedWorkItemCount: results.length,
              latestResult: results.at(-1) ?? null
            };
            await writeJson(stateFile, currentState);

            const result = await runHistoricalReport({
              page: session.page,
              account,
              report,
              dealerCode,
              range
            });
            reportResults.push(result);

            if (result.browserClosed) {
              logger.warn(`${account.logPrefix} historical browser closed; relogging once for same dealer`, {
                dealerCode,
                range: `${range.startIso} to ${range.endIso}`,
                failedReportId: report.id
              });
              await session?.close?.().catch(() => {});
              session = await loginForDealer(account, dealerCode);
            }
          }

          const summary = summarizeRange({
            dealerCode,
            dealerIndex,
            range,
            rangeIndex,
            reportResults
          });
          results.push(summary);

          const failed = summary.failedReportCount > 0;
          const state = {
            ...initialState,
            status: failed ? 'running_with_failures' : 'running',
            updatedAt: new Date().toISOString(),
            currentDealerCode: dealerCode,
            currentDealerIndex: dealerIndex,
            currentRangeIndex: rangeIndex,
            currentReportId: null,
            lastCompletedRangeIndex: rangeIndex,
            nextDealerIndex: rangeIndex + 1 >= ranges.length ? dealerIndex + 1 : dealerIndex,
            nextRangeIndex: rangeIndex + 1 >= ranges.length ? 0 : rangeIndex + 1,
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
            reports: reportResults,
            failedReports: reportResults.filter(report => report.status === 'failed')
          });
          writeLogLine(logStream, {
            event: 'range_completed',
            dealerCode,
            rangeIndex,
            startIso: range.startIso,
            endIso: range.endIso,
            successCount: summary.successCount,
            failureCount: summary.failureCount
          });

          if (failed && stopOnFailure) {
            throw new Error(`${account.logPrefix} historical range failed and stop-on-failure is enabled: ${dealerCode} ${range.startIso} to ${range.endIso}`);
          }
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

    const failedRanges = results.filter(result => result.failedReportCount > 0);
    const finalState = {
      ...initialState,
      status: failedRanges.length ? 'completed_with_failures' : 'success',
      completedAt: new Date().toISOString(),
      completedWorkItemCount: results.length,
      failedWorkItemCount: failedRanges.length,
      results: results.map(result => ({
        dealerCode: result.dealerCode,
        rangeIndex: result.rangeIndex,
        monthKey: result.monthKey,
        rangeKey: result.rangeKey,
        startIso: result.startIso,
        endIso: result.endIso,
        exitCode: result.exitCode,
        status: result.status,
        failedReportCount: result.failedReportCount,
        successCount: result.successCount,
        failureCount: result.failureCount,
        reportSummaries: result.reportSummaries,
        failedReportIds: result.failedReports?.map(report => report.reportId) ?? [],
        failedLoopCount: result.failedLoops?.length ?? 0
      }))
    };
    await writeJson(stateFile, finalState);
    await writeHealthStatus(account, {
      status: failedRanges.length ? 'completed_with_failures' : 'success',
      mode: reportIds.join(','),
      dealerCodes: selectedDealersForRun,
      startedAt: startedAt.toISOString(),
      completedAt: finalState.completedAt,
      reports: results.flatMap(result => result.reportSummaries),
      failedReports: results.flatMap(result => result.failedReports)
    });
  } finally {
    logStream.end();
  }
}
