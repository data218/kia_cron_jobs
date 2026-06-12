import { spawn } from 'node:child_process';
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

const REPORTS_TO_RUN_IN_PARALLEL = [
  'hyundai-adv-wise-lubricants-vas',
  'hyundai-operation-wise-analysis-report',
  'hyundai-psf-yearly',
  'hyundai-ew-report',
  'hyundai-mcp-report',
  'hyundai-demo-car-list',
  'hyundai-service-appointment',
  'hyundai-open-ro-yearly',
  'hyundai-demo-job-cards',
  'hyundai-call-center-complaints',
  'hyundai-trust-package-bodyshop-sot',
  'hyundai-trust-package-sot-super'
];

const STAGGER_MS = 3 * 60 * 1000;

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
      label: `${account.logPrefix} parallel historical DMS login`
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

export async function runParallelOptimizedBackfill({
  accountId = 'am-platinum',
  envPrefix = 'AM_PLATINUM',
  reportSuffix = '',
  defaultHeadless = false,
  staggerMs = STAGGER_MS,
  reportsToRun = REPORTS_TO_RUN_IN_PARALLEL
} = {}) {
  await fsp.mkdir(config.logsDir, { recursive: true });

  const baseAccount = createGdmsAccountProfile(accountId);
  const account = {
    ...baseAccount,
    forceLogin: envBool(`${envPrefix}_HISTORICAL_FORCE_LOGIN`, baseAccount.forceLogin),
    headless: envBool(`${envPrefix}_HISTORICAL_HEADLESS`, defaultHeadless),
    serviceName: 'am-platinum-parallel-backfill'
  };
  const reports = selectedReports({ account, envPrefix });
  const reportIds = reports.map(report => report.id);
  const dealerCodes = selectedDealers({ account, envPrefix });

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const stateFileName = `am-platinum-parallel-backfill${reportSuffix}-${runId}.json`;
  const stateFile = path.join(config.logsDir, stateFileName);
  const logFileName = `am-platinum-parallel-backfill${reportSuffix}-${runId}.log`;
  const logFile = path.join(config.logsDir, logFileName);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const results = [];
  const startedAt = new Date();

  const initialState = {
    status: 'running',
    mode: 'parallel-optimized-full-range-no-search',
    reportSuffix,
    startedAt: startedAt.toISOString(),
    selectedDealerCount: dealerCodes.length,
    reportIds: reportsToRun,
    dealerCodes,
    headless: account.headless,
    logFile
  };

  const writeLogLine = (payload) => {
    const line = typeof payload === 'string'
      ? payload
      : JSON.stringify({ time: new Date().toISOString(), ...payload });
    process.stdout.write(`${line}\n`);
    logStream.write(`${line}\n`);
  };

  await writeJson(stateFile, { ...initialState, status: 'launching' });

  await waitForConnectivity({ label: `${account.logPrefix} parallel backfill startup` });

  for (const [idx, reportId] of reportsToRun.entries()) {
    const reportDef = reports.find(r => r.id === reportId);
    const reportName = reportDef?.name ?? reportId;

    writeLogLine({
      event: 'report_launching',
      reportId,
      report: reportName,
      index: idx + 1,
      total: reportsToRun.length,
      dealerCodes,
      headless: account.headless
    });

    const child = spawn(process.execPath, [
      'scripts/run-am-platinum-single-report.js',
      '--report', reportId,
      '--headless', account.headless ? 'true' : 'false',
      '--state-file', path.join(config.logsDir, `${reportSuffix || reportId}-${runId}.json`),
      '--log-file', path.join(config.logsDir, `${reportSuffix || reportId}-${runId}.log`)
    ], {
      cwd: config.rootDir,
      env: {
        ...process.env,
        AM_PLATINUM_HISTORICAL_REPORTS: reportId,
        AM_PLATINUM_HISTORICAL_HEADLESS: account.headless ? 'true' : 'false',
        AM_PLATINUM_HISTORICAL_FORCE_LOGIN: 'false',
        AM_PLATINUM_HISTORICAL_STOP_ON_FAILURE: 'true',
        AM_PLATINUM_HISTORICAL_RESUME_FROM_STATE: 'false'
      },
      stdio: 'inherit',
      detached: true
    });

    child.unref();

    writeLogLine({
      event: 'report_launched',
      reportId,
      report: reportName,
      index: idx + 1,
      total: reportsToRun.length,
      pid: child.pid
    });

    if (idx < reportsToRun.length - 1) {
      writeLogLine({
        event: 'stagger_wait',
        reportId,
        nextReport: reportsToRun[idx + 1],
        waitMinutes: staggerMs / 60000
      });
      await sleep(staggerMs);
    }
  }

  writeLogLine({
    event: 'all_launched',
    reportCount: reportsToRun.length,
    dealerCodes,
    headless: account.headless,
    logFile
  });

  await writeJson(stateFile, {
    ...initialState,
    status: 'all_processes_launched',
    completedAt: new Date().toISOString(),
    reportPids: [] 
  });

  logStream.end();
}

async function writeJson(filePath, payload) {
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
}

await runParallelOptimizedBackfill();
