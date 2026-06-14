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

const MISSING_REPORTS = [
  'hyundai-adv-wise-lubricants-vas'
];

function env(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
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

function selectedDealers({ account, envPrefix }) {
  const dealers = env(`${envPrefix}_HISTORICAL_DEALERS`, account.dealerCodes.join(','))
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
  return dealers.length ? dealers : ['active'];
}

function selectedReports({ account, envPrefix }) {
  const requested = env(`${envPrefix}_HISTORICAL_REPORTS`, MISSING_REPORTS.join(','));
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
      label: `${account.logPrefix} optimized historical DMS login`
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
    logger.error(`${account.logPrefix} optimized backfill failed; continuing`, {
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

export async function runOptimizedHistoricalBackfill({
  accountId = 'am-platinum',
  envPrefix = 'AM_PLATINUM',
  stateFileName = 'am-platinum-optimized-backfill-state.json',
  logFilePrefix = 'am-platinum-optimized-backfill',
  serviceName = 'am-platinum-optimized-backfill',
  defaultHeadless = false
} = {}) {
  await fsp.mkdir(config.logsDir, { recursive: true });

  const baseAccount = createGdmsAccountProfile(accountId);
  const account = {
    ...baseAccount,
    forceLogin: envBool(`${envPrefix}_HISTORICAL_FORCE_LOGIN`, baseAccount.forceLogin),
    headless: envBool(`${envPrefix}_HISTORICAL_HEADLESS`, defaultHeadless),
    otpProvider: env(
      `${envPrefix}_HISTORICAL_OTP_PROVIDER`,
      accountId === 'am-platinum' ? config.amPlatinumHistoricalOtpProvider : 'manual'
    ),
    serviceName
  };
  const reports = selectedReports({ account, envPrefix });
  const reportIds = reports.map(report => report.id);
  const dealerCodes = selectedDealers({ account, envPrefix });
  const stateFile = path.join(config.logsDir, stateFileName);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(config.logsDir, `${logFilePrefix}-${runId}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const results = [];
  const startedAt = new Date();

  const initialState = {
    status: 'running',
    mode: 'optimized-full-range-no-search',
    strategy: 'single-full-range-per-report-per-dealer',
    startedAt: startedAt.toISOString(),
    selectedDealerCount: dealerCodes.length,
    reportIds,
    dealerCodes,
    headless: account.headless,
    logFile
  };
  await writeJson(stateFile, initialState);

  try {
    await waitForConnectivity({ label: `${account.logPrefix} optimized backfill startup` });

    for (const dealerCode of dealerCodes) {
      const dealerIndex = dealerCodes.indexOf(dealerCode);
      let session = null;

      try {
        writeLogLine(logStream, {
          event: 'dealer_started',
          accountId: account.id,
          dealerCode,
          reportCount: reports.length,
          mode: 'optimized-full-range'
        });
        session = await loginForDealer(account, dealerCode);

        for (const report of reports) {
          const reportIndex = reports.findIndex(candidate => candidate.id === report.id);

          writeLogLine(logStream, {
            event: 'report_started',
            dealerCode,
            reportId: report.id,
            report: report.name,
            reportIndex,
            mode: 'full-range-no-search'
          });

          const result = await runOptimizedReportRange({
            page: session.page,
            account,
            report,
            dealerCode,
            skipNavigation: false
          });
          results.push(result);

          writeLogLine(logStream, {
            event: 'report_completed',
            dealerCode,
            reportId: report.id,
            status: result.status,
            rowCount: result.rowCount,
            pageCount: result.pageCount,
            durationMs: result.durationMs,
            dbAction: result.dbAction
          });

          if (result.status === 'failed' && result.browserClosed) {
            await session?.close?.().catch(() => {});
            session = await loginForDealer(account, dealerCode);
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
    
    writeLogLine(logStream, {
      event: 'backfill_completed',
      status: finalState.status,
      completedAt: finalState.completedAt,
      totalResults: results.length,
      failedResults: failedResults.length
    });
  } finally {
    logStream.end();
  }
}

function slugifyReportId(reportId) {
  return String(reportId || 'all').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

const reportSlug = slugifyReportId(env('AM_PLATINUM_HISTORICAL_REPORTS', 'hyundai-adv-wise-lubricants-vas').split(',')[0]);

await runOptimizedHistoricalBackfill({
  stateFileName: env('AM_PLATINUM_HISTORICAL_STATE_FILE', `am-platinum-optimized-${reportSlug}-state.json`),
  logFilePrefix: env('AM_PLATINUM_HISTORICAL_LOG_PREFIX', `am-platinum-optimized-${reportSlug}`),
  serviceName: env('LOG_SERVICE_NAME', `am-platinum-opt-${reportSlug}`)
});
