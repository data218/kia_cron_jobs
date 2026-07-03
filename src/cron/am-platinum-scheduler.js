import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { loginToHmilDms } from '../auth/hmil-login.js';
import { getSelectedHmilReports } from '../reports/hmil-reports.js';
import { changeActiveDealerForDms } from '../navigation/dealer-change.js';
import { refreshAmPlatinumMaterializedViews } from '../supabase/materialized-views.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { executeWithRetry } from '../utils/execute-with-retry.js';
import { waitForConnectivity } from '../utils/network.js';
import { createGdmsAccountProfile } from '../accounts/gdms-account-profile.js';
import { clearCheckpoint, readCheckpoint, writeCheckpoint } from '../utils/checkpoint.js';
import { isBrowserClosedError } from '../utils/failure.js';

// ─── Dealer split ──────────────────────────────────────────────────────────────
// MIS12345 (historical account) → N5211, N6828  (only these appear in its portal)
// MIS1988  (current account)   → N6250          (only this appears in its portal)
const HISTORICAL_DEALERS = ['N5211', 'N6828'];
const CURRENT_DEALERS    = ['N6250'];

let running = false;

function serializeError(error) {
  return { name: error.name, message: error.message, stack: error.stack };
}

function isActiveDealerAlias(dealerCode) {
  return !dealerCode || ['active', 'current', 'default'].includes(String(dealerCode).trim().toLowerCase());
}

function resolvedLoginRetries(account) {
  return Number.isInteger(account?.loginRetries)
    ? account.loginRetries
    : config.loginRetries;
}

function modeFromArgs(defaultMode = 'am-platinum-regular') {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='));
  return modeArg ? modeArg.slice('--mode='.length) : defaultMode;
}

// ─── Health file helpers ───────────────────────────────────────────────────────
async function writeHealthStatus(status) {
  const payload = {
    service: 'am-platinum-cron-job',
    accountId: 'am-platinum',
    brand: 'am_platinum',
    env: process.env.NODE_ENV || 'development',
    updatedAt: new Date().toISOString(),
    ...status
  };
  const filePath = path.join(config.logsDir, 'am-platinum-health.json');
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  logger.info('AM Platinum health status updated', { status: payload.status, filePath });
}

// ─── Run all reports for a given account + dealer list ─────────────────────────
async function runSessionForDealers(account, dealerCodes, mode, reportResults) {
  if (dealerCodes.length === 0) return;

  logger.info(`AM Platinum session starting for dealers: ${dealerCodes.join(', ')}`, {
    userId: account.userId
  });

  const session = await retry(
    async () => loginToHmilDms(account),
    {
      attempts: resolvedLoginRetries(account) + 1,
      delayMs: config.retryDelayMs,
      label: `AM Platinum DMS login (${account.userId})`
    }
  );

  try {
    const selectedReports = getSelectedHmilReports(mode, account);
    const tasks = selectedReports.flatMap(report =>
      dealerCodes.map(dealerCode => ({
        report,
        dealerCode,
        taskKey: `${report.id}:${dealerCode}`
      }))
    );
    const checkpointName = `${account.id}-${String(mode).replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()}`;
    const checkpoint = await readCheckpoint(checkpointName);
    const taskKeys = tasks.map(task => task.taskKey);
    const canResume = checkpoint?.mode === mode
      && JSON.stringify(checkpoint?.taskKeys ?? []) === JSON.stringify(taskKeys)
      && Number.isInteger(checkpoint?.nextIndex)
      && checkpoint.nextIndex >= 0
      && checkpoint.nextIndex < tasks.length;
    const startIndex = canResume ? checkpoint.nextIndex : 0;
    let activeDealerCode = null;
    let firstFailureIndex = null;

    for (let index = startIndex; index < tasks.length; index += 1) {
      const { report, dealerCode } = tasks[index];
      if (index === startIndex || tasks[index - 1]?.report.id !== report.id) {
        logger.info('AM Platinum report batch started', {
          reportId: report.id,
          report: report.name,
          dealerCodes,
          userId: account.userId
        });
      }

      if (firstFailureIndex == null) {
        await writeCheckpoint(checkpointName, {
          mode,
          nextIndex: index,
          taskKeys
        });
      }

        try {
          if (!isActiveDealerAlias(dealerCode) && activeDealerCode !== dealerCode) {
            await changeActiveDealerForDms(session.page, dealerCode, {
              homeUrl: account.homeUrl,
              systemLabel: account.systemLabel
            });
            activeDealerCode = dealerCode;
          }
        } catch (error) {
          logger.error('AM Platinum dealer change failed; skipping this dealer/report pair', {
            reportId: report.id,
            report: report.name,
            dealerCode,
            userId: account.userId,
            currentUrl: session.page.url(),
            err: serializeError(error)
          });
          reportResults.push({
            status: 'failed',
            reportId: report.id,
            report: report.name,
            dealerCode,
            phase: 'dealer-change',
            error: serializeError(error)
          });
          activeDealerCode = null;
          if (firstFailureIndex == null) {
            firstFailureIndex = index;
          }
          await writeCheckpoint(checkpointName, {
            mode,
            nextIndex: firstFailureIndex,
            taskKeys,
            failedTask: {
              reportId: report.id,
              dealerCode,
              phase: 'dealer-change'
            }
          });
          if (isBrowserClosedError(error)) {
            logger.error('AM Platinum browser/session closed during dealer change; aborting remaining tasks', {
              reportId: report.id,
              dealerCode,
              userId: account.userId
            });
            break;
          }
          continue;
        }

        const label = `${report.name} [${dealerCode}]`;
        const startedAt = Date.now();
        try {
          const result = await executeWithRetry({
            name: label,
            page: session.page,
            fn: () => report.run(session.page, { dealerCode, account })
          });
          logger.info('AM Platinum report/dealer completed', {
            reportId: report.id,
            report: report.name,
            dealerCode,
            userId: account.userId,
            sheetName: result.sheetName,
            dbAction: result.dbResult?.action,
            rowCount: result.dbResult?.rowCount,
            durationMs: Date.now() - startedAt
          });
          reportResults.push({
            status: 'success',
            reportId: report.id,
            report: report.name,
            dealerCode,
            sheetName: result.sheetName,
            dbAction: result.dbResult?.action,
            rowCount: result.dbResult?.rowCount,
            durationMs: Date.now() - startedAt
          });
        } catch (error) {
          logger.error('AM Platinum report/dealer failed after retries; continuing', {
            reportId: report.id,
            report: report.name,
            dealerCode,
            userId: account.userId,
            durationMs: Date.now() - startedAt,
            currentUrl: session.page.url(),
            err: serializeError(error)
          });
          reportResults.push({
            status: 'failed',
            reportId: report.id,
            report: report.name,
            dealerCode,
            durationMs: Date.now() - startedAt,
            currentUrl: session.page.url(),
            error: serializeError(error)
          });
          if (firstFailureIndex == null) {
            firstFailureIndex = index;
          }
          await writeCheckpoint(checkpointName, {
            mode,
            nextIndex: firstFailureIndex,
            taskKeys,
            failedTask: {
              reportId: report.id,
              dealerCode,
              phase: 'report-run'
            }
          });
          if (isBrowserClosedError(error)) {
            logger.error('AM Platinum browser/session closed during report execution; aborting remaining tasks', {
              reportId: report.id,
              dealerCode,
              userId: account.userId
            });
            break;
          }
        }

      if (firstFailureIndex == null) {
        if (index + 1 < tasks.length) {
          await writeCheckpoint(checkpointName, {
            mode,
            nextIndex: index + 1,
            taskKeys
          });
        } else {
          await clearCheckpoint(checkpointName);
        }
      }
    }

    if (firstFailureIndex == null) {
      await clearCheckpoint(checkpointName);
    }
  } finally {
    await session?.close?.().catch(() => {});
  }
}

// ─── Main run function ─────────────────────────────────────────────────────────
async function run(mode = 'am-platinum-regular') {
  if (running) {
    logger.warn('AM Platinum scheduler already running, skipping overlapping execution', { mode });
    return;
  }
  running = true;
  const startedAt = Date.now();

  // Build both account profiles
  const baseProfile = createGdmsAccountProfile('am-platinum');

  // MIS1988 account (current) — for N6250
  const currentAccount = {
    ...baseProfile,
    dealerCodes: CURRENT_DEALERS
  };

  // MIS12345 account (historical) — for N5211, N6828
  const historicalAccount = {
    ...baseProfile,
    id: 'am-platinum-historical',
    displayName: config.amPlatinumHistoricalUserId || 'MIS12345',
    logPrefix: `AM Platinum ${config.amPlatinumHistoricalUserId || 'MIS12345'}`,
    userId: config.amPlatinumHistoricalUserId,
    password: config.amPlatinumHistoricalPassword,
    userIdEnvName: 'AM_PLATINUM_HISTORICAL_USER_ID',
    passwordEnvName: 'AM_PLATINUM_HISTORICAL_PASSWORD',
    sessionStatePath: config.amPlatinumHistoricalSessionStatePath,
    dealerCodes: HISTORICAL_DEALERS
  };

  try {
    await Promise.all([
      fs.mkdir(config.logsDir, { recursive: true }),
      fs.mkdir(config.screenshotsDir, { recursive: true }),
      fs.mkdir(baseProfile.downloadDir, { recursive: true }),
      fs.mkdir(baseProfile.reportChunksDir, { recursive: true }),
      fs.mkdir(path.dirname(baseProfile.sessionStatePath), { recursive: true }),
      fs.mkdir(path.dirname(historicalAccount.sessionStatePath), { recursive: true })
    ]);

    logger.info('AM Platinum report automation job started', { mode });
    await waitForConnectivity({ label: 'AM Platinum scheduler startup' });
    await writeHealthStatus({
      status: 'running',
      mode,
      dealerCodes: [...HISTORICAL_DEALERS, ...CURRENT_DEALERS],
      startedAt: new Date(startedAt).toISOString()
    });

    const reportResults = [];

    // ── Phase 1: MIS12345 → N5211, N6828 ──────────────────────────────────────
    // Skip Phase 1 if --phase2-only flag is set (used for manual resume)
    const skipPhase1 = process.argv.includes('--phase2-only') || process.env.AM_PLATINUM_SKIP_PHASE1 === 'true';
    if (skipPhase1) {
      logger.info('AM Platinum Phase 1 skipped (--phase2-only / AM_PLATINUM_SKIP_PHASE1 flag)');
    } else {
      logger.info('AM Platinum Phase 1: logging in as MIS12345 for N5211, N6828');
      await runSessionForDealers(historicalAccount, HISTORICAL_DEALERS, mode, reportResults);
    }

    // ── Phase 2: MIS1988 → N6250 ──────────────────────────────────────────────
    logger.info('AM Platinum Phase 2: logging in as MIS1988 for N6250');
    await runSessionForDealers(currentAccount, CURRENT_DEALERS, mode, reportResults);

    // ── Materialized views ─────────────────────────────────────────────────────
    const failedReports = reportResults.filter(r => r.status === 'failed');
    const successfulReports = reportResults.filter(r => r.status === 'success');

    if (failedReports.length === 0) {
      logger.info('AM Platinum all imports completed successfully; refreshing Platinum materialized views');
      await refreshAmPlatinumMaterializedViews();
      logger.info('AM Platinum Platinum materialized views refreshed');
    } else {
      logger.warn('AM Platinum skipping materialized view refresh due to failures', {
        failureCount: failedReports.length
      });
    }

    logger.info('AM Platinum report automation job finished', {
      status: failedReports.length ? 'completed_with_failures' : 'success',
      successCount: successfulReports.length,
      failureCount: failedReports.length
    });
    await writeHealthStatus({
      status: failedReports.length ? 'completed_with_failures' : 'success',
      mode,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      dealerCodes: [...HISTORICAL_DEALERS, ...CURRENT_DEALERS],
      reports: reportResults,
      failedReports
    });
  } catch (error) {
    logger.error('AM Platinum report automation job failed', {
      mode,
      err: serializeError(error)
    });
    await writeHealthStatus({
      status: 'failed',
      mode,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error: serializeError(error)
    }).catch(() => {});
    process.exitCode = 1;
  } finally {
    running = false;
  }
}

function parseCronSchedules(cronScheduleStr) {
  if (!cronScheduleStr) return [];
  const schedules = [];
  const parts = cronScheduleStr.split(',').map(s => s.trim()).filter(Boolean);
  let buf = '';
  for (const part of parts) {
    const test = buf ? `${buf},${part}` : part;
    const segments = test.split(/\s+/).filter(Boolean);
    if (segments.length >= 5) {
      schedules.push(test);
      buf = '';
    } else {
      buf = test;
    }
  }
  if (buf) schedules.push(buf);
  return schedules;
}

// ─── Scheduling ────────────────────────────────────────────────────────────────
function schedule() {
  const schedules = parseCronSchedules(config.amPlatinumCronSchedule);
  const skipPhase1 = process.env.AM_PLATINUM_SKIP_PHASE1 === 'true';
  const activeDealers = skipPhase1 ? CURRENT_DEALERS : [...HISTORICAL_DEALERS, ...CURRENT_DEALERS];

  for (const schedulePattern of schedules) {
    logger.info('Scheduling AM Platinum report automation job', {
      cron: schedulePattern,
      mode: 'am-platinum-regular',
      dealerCodes: activeDealers,
      reportsToRun: config.amPlatinumReportsToRun,
      phase1: skipPhase1 ? 'SKIPPED' : `MIS12345 → ${HISTORICAL_DEALERS.join(', ')}`,
      phase2: `MIS1988  → ${CURRENT_DEALERS.join(', ')}`
    });
    cron.schedule(
      schedulePattern,
      () => run('am-platinum-regular'),
      { timezone: config.amPlatinumCronTimezone ?? config.kiaCronTimezone }
    );
  }
}

export const runAmPlatinumDmsJob = run;

// ─── CLI / PM2 entry point ─────────────────────────────────────────────────────
// Handles three modes:
//   --scheduler   : PM2 daemon — registers cron schedules, keeps process alive
//   --once        : One-shot run of both phases (manual trigger)
//   --phase2-only : One-shot run of Phase 2 only (MIS1988 → N6250 resume)
const resolvedPath = process.env.pm_exec_path || process.argv[1];
const isMain = resolvedPath && import.meta.url.endsWith(path.basename(resolvedPath));
const shouldRunFromCli = isMain
  || process.argv.includes('--scheduler')
  || process.argv.includes('--once')
  || process.argv.includes('--phase2-only');

if (shouldRunFromCli) {
  if (process.argv.includes('--scheduler')) {
    schedule();
  } else {
    await run(modeFromArgs('am-platinum-regular'));
  }
}
