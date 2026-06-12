import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { getSelectedHmilReports } from '../src/reports/hmil-reports.js';
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
import { sleep } from '../src/utils/sleep.js';

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function envBool(name, fallback) {
  const raw = env(name);
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function envInt(name, fallback = null) {
  const raw = env(name, '');
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function selectedDealers({ account, envPrefix }) {
  const dealers = env(`${envPrefix}_HISTORICAL_DEALERS`, account.dealerCodes.join(','))
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
  return dealers.length ? dealers : ['active'];
}

function selectedReports({ account, envPrefix }) {
  const requested = env(`${envPrefix}_HISTORICAL_REPORTS`, 'hyundai-transaction-list');
  return getSelectedHmilReports(requested, account);
}

function isActiveDealerAlias(dealerCode) {
  return !dealerCode || ['active', 'current', 'default'].includes(String(dealerCode).trim().toLowerCase());
}

async function loginForDealer(account, dealerCode) {
  const session = await retry(
    async () => loginToHmilDms(account),
    {
      attempts: config.loginRetries + 1,
      delayMs: config.retryDelayMs,
      label: `${account.logPrefix} parallel DMS login`
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

async function runOptimizedReportRange({ page, account, report, dealerCode, skipNavigation = false }) {
  const label = `${report.name} [${dealerCode}] full-range optimized`;
  const startedAt = Date.now();
  const startIso = '2021-01-01';
  const endIso = toIsoDate(new Date());
  const startDate = parseIsoLocalDate(startIso);
  const endDate = parseIsoLocalDate(endIso);
  const range = {
    startDate,
    endDate,
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso,
    endIso
  };

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
        pageSize: '1000',
        maxPages: envInt('AM_PLATINUM_OPTIMIZED_MAX_PAGES', null)
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
      pageCount: result.pageCount,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const currentUrl = await currentPageUrl(page);
    logger.error(`${account.logPrefix} optimized backfill failed`, {
      reportId: report.id,
      report: report.name,
      dealerCode,
      durationMs: Date.now() - startedAt,
      currentUrl,
      err: serializeError(error)
    });

    return {
      status: 'failed',
      reportId: report.id,
      report: report.name,
      dealerCode,
      phase: 'optimized-report',
      durationMs: Date.now() - startedAt,
      currentUrl,
      browserClosed: browserClosedBy(error),
      error: serializeError(error)
    };
  }
}

async function main() {
  const headless = envBool('AM_PLATINUM_HISTORICAL_HEADLESS', false);
  const logFilePath = env('LOG_FILE', path.join(config.logsDir, `single-am-platinum-backfill.log`));
  const stateFilePath = env('STATE_FILE', path.join(config.logsDir, 'single-am-platinum-backfill-state.json'));

  await fsp.mkdir(path.dirname(logFilePath), { recursive: true });
  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

  function writeLogLine(payload) {
    const line = typeof payload === 'string'
      ? payload
      : JSON.stringify({ time: new Date().toISOString(), ...payload });
    process.stdout.write(`${line}\n`);
    logStream.write(`${line}\n`);
  }

  async function writeJson(filePath, payload) {
    await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
  }

  const account = createGdmsAccountProfile('am-platinum');
  const accountConfig = {
    ...account,
    headless,
    serviceName: 'am-platinum-single-report-backfill'
  };

  const reports = selectedReports({ account: accountConfig, envPrefix: 'AM_PLATINUM' });
  const reportIds = reports.map(r => r.id);
  const dealerCodes = selectedDealers({ account: accountConfig, envPrefix: 'AM_PLATINUM' });

  const initialState = {
    status: 'running',
    mode: 'single-report-optimized-full-range',
    reportIds,
    startedAt: new Date().toISOString(),
    dealerCodes,
    headless,
    logFile: logFilePath
  };

  await writeJson(stateFilePath, initialState);
  writeLogLine({ event: 'started', reportIds, dealerCodes, headless });

  await waitForConnectivity({ label: `${account.logPrefix} single report backfill startup` });

  const results = [];

  try {
    for (const report of reports) {
      for (const dealerCode of dealerCodes) {
        writeLogLine({
          event: 'report_started',
          reportId: report.id,
          report: report.name,
          dealerCode
        });

        let session;
        try {
          session = await loginForDealer(accountConfig, dealerCode);
        } catch (error) {
          writeLogLine({
            event: 'login_failed',
            reportId: report.id,
            dealerCode,
            err: serializeError(error)
          });
          results.push({
            status: 'failed',
            reportId: report.id,
            dealerCode,
            phase: 'login',
            error: serializeError(error)
          });
          continue;
        }

        try {
          const result = await runOptimizedReportRange({
            page: session.page,
            account: accountConfig,
            report,
            dealerCode,
            skipNavigation: false
          });

          results.push(result);

          writeLogLine({
            event: 'report_completed',
            reportId: report.id,
            dealerCode,
            status: result.status,
            rowCount: result.rowCount,
            pageCount: result.pageCount,
            dbAction: result.dbAction,
            durationMs: result.durationMs
          });
        } catch (error) {
          writeLogLine({
            event: 'report_failed',
            reportId: report.id,
            dealerCode,
            err: serializeError(error)
          });
          results.push({
            status: 'failed',
            reportId: report.id,
            dealerCode,
            error: serializeError(error)
          });
        } finally {
          await session?.close?.().catch(() => {});
        }
      }
    }

    const failedResults = results.filter(r => r.status === 'failed');
    const finalState = {
      ...initialState,
      status: failedResults.length ? 'completed_with_failures' : 'success',
      completedAt: new Date().toISOString(),
      results
    };
    await writeJson(stateFilePath, finalState);

    writeLogLine({
      event: 'backfill_completed',
      status: finalState.status,
      completedAt: finalState.completedAt,
      totalResults: results.length,
      failedResults: failedResults.length
    });
  } catch (error) {
    writeLogLine({
      event: 'backfill_failed',
      err: serializeError(error)
    });
    await writeJson(stateFilePath, {
      ...initialState,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: serializeError(error)
    });
  } finally {
    logStream.end();
  }
}

main();
