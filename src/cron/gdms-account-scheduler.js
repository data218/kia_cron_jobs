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
import { checkpointRetryIndexes, checkpointStaleReason, clearCheckpoint, readCheckpoint, writeCheckpoint } from '../utils/checkpoint.js';
import { toIsoDate } from '../utils/date-range.js';
import { isBrowserClosedError } from '../utils/failure.js';

function getCliMode(defaultMode) {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='));
  return modeArg ? modeArg.slice('--mode='.length) : defaultMode;
}

function resolvedLoginRetries(account) {
  return Number.isInteger(account?.loginRetries)
    ? account.loginRetries
    : config.loginRetries;
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

function dealerCodesForReport(report, account) {
  if (Array.isArray(report?.dealerCodes) && report.dealerCodes.length) {
    return report.dealerCodes;
  }

  return account.dealerCodes.length ? account.dealerCodes : ['active'];
}

function taskKeyForReport(report, dealerCode) {
  return `${report.id}:${dealerCode}`;
}

function buildReportTasks(selectedReports, account) {
  return selectedReports.flatMap(report =>
    dealerCodesForReport(report, account).map(dealerCode => ({
      report,
      dealerCode,
      taskKey: taskKeyForReport(report, dealerCode)
    }))
  );
}

function checkpointNameForRun(account, mode) {
  const safeMode = String(mode || account.defaultMode)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .toLowerCase();
  return `${account.id}-${safeMode}`;
}

export function createGdmsAccountScheduler(account) {
  let running = false;

  async function ensureRuntimeDirs() {
    await Promise.all([
      fs.mkdir(config.logsDir, { recursive: true }),
      fs.mkdir(config.screenshotsDir, { recursive: true }),
      fs.mkdir(account.downloadDir, { recursive: true }),
      fs.mkdir(account.reportChunksDir, { recursive: true }),
      fs.mkdir(path.dirname(account.sessionStatePath), { recursive: true })
    ]);
  }

  async function writeHealthStatus(status) {
    const payload = {
      service: account.serviceName,
      accountId: account.id,
      brand: account.brand,
      env: process.env.NODE_ENV || 'development',
      updatedAt: new Date().toISOString(),
      ...status
    };

    const filePath = path.join(config.logsDir, account.healthFileName);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
    logger.info(`${account.logPrefix} health status updated`, {
      status: payload.status,
      filePath
    });
  }

  async function switchDealerIfNeeded(page, dealerCode, activeDealerCode) {
    if (isActiveDealerAlias(dealerCode)) {
      logger.info(`Using current active ${account.logPrefix} dealer; skipping dealer change`);
      return activeDealerCode;
    }

    if (activeDealerCode === dealerCode) {
      logger.info(`${account.logPrefix} dealer already active; skipping dealer change`, { dealerCode });
      return activeDealerCode;
    }

    await changeActiveDealerForDms(page, dealerCode, {
      homeUrl: account.homeUrl,
      systemLabel: account.systemLabel
    });
    return dealerCode;
  }

  async function runReportForDealer(page, report, dealerCode) {
    const label = `${report.name} [${dealerCode}]`;
    const startedAt = Date.now();

    try {
      const result = await executeWithRetry({
        name: label,
        page,
        fn: () => report.run(page, { dealerCode, account })
      });

      logger.info(`${account.logPrefix} report/dealer completed`, {
        reportId: report.id,
        report: report.name,
        dealerCode,
        sheetName: result.sheetName,
        dbAction: result.dbResult?.action,
        rowCount: result.dbResult?.rowCount,
        failedLoopCount: result.dbResult?.failedLoopCount,
        durationMs: Date.now() - startedAt
      });

      return {
        status: 'success',
        reportId: report.id,
        report: report.name,
        dealerCode,
        sheetName: result.sheetName,
        dbAction: result.dbResult?.action,
        rowCount: result.dbResult?.rowCount,
        failedLoopCount: result.dbResult?.failedLoopCount,
        failedLoops: result.dbResult?.failedLoops,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      logger.error(`${account.logPrefix} report/dealer failed after retries; continuing with remaining reports`, {
        reportId: report.id,
        report: report.name,
        dealerCode,
        durationMs: Date.now() - startedAt,
        currentUrl: page.url(),
        err: serializeError(error)
      });

      return {
        status: 'failed',
        reportId: report.id,
        report: report.name,
        dealerCode,
        durationMs: Date.now() - startedAt,
        currentUrl: page.url(),
        error: serializeError(error)
      };
    }
  }

  async function run(mode = account.defaultMode) {
    if (running) {
      logger.warn(`${account.logPrefix} scheduler already running, skipping overlapping execution`, { mode });
      return;
    }

    running = true;
    let session;
    const startedAt = Date.now();

    try {
      await ensureRuntimeDirs();
      logger.info(`${account.logPrefix} report automation job started`, { mode });
      await waitForConnectivity({ label: `${account.logPrefix} scheduler ${mode} startup` });
      await writeHealthStatus({
        status: 'running',
        mode,
        dealerCodes: account.dealerCodes,
        startedAt: new Date(startedAt).toISOString()
      });

      session = await retry(
        async () => loginToHmilDms(account),
        {
          attempts: resolvedLoginRetries(account) + 1,
          delayMs: config.retryDelayMs,
          label: `${account.logPrefix} DMS login`
        }
      );

      const selectedReports = getSelectedHmilReports(mode, account);
      const tasks = buildReportTasks(selectedReports, account);
      const checkpointName = checkpointNameForRun(account, mode);
      const checkpoint = await readCheckpoint(checkpointName);
      const taskKeys = tasks.map(task => task.taskKey);
      const runDate = toIsoDate(new Date());
      const staleReason = checkpointStaleReason(checkpoint, { mode, runDate, taskKeys });
      const canResume = !staleReason;
      const resumeIndex = canResume ? checkpoint.nextIndex : 0;
      // A task that failed is not a task that is done: it stays recorded below the resume frontier
      // and is re-run first. Before this, the frontier moved past failures and they were skipped
      // forever - three feeds sat stale for days after the 2026-09-01 run.
      const retryIndexes = canResume
        ? checkpointRetryIndexes(checkpoint, tasks.length).filter(index => index < resumeIndex)
        : [];
      const pendingIndexes = [
        ...retryIndexes,
        ...Array.from({ length: tasks.length - resumeIndex }, (_, offset) => resumeIndex + offset)
      ];
      const failedIndexes = new Set(retryIndexes);
      const reportResults = [];
      let activeDealerCode = null;
      let nextIndex = resumeIndex;

      async function saveCheckpoint(failedTask) {
        await writeCheckpoint(checkpointName, {
          mode,
          runDate,
          nextIndex,
          failedIndexes: [...failedIndexes].sort((a, b) => a - b),
          taskKeys,
          failedTask
        });
      }

      logger.info(`${account.logPrefix} reports selected`, {
        mode,
        reportCount: selectedReports.length,
        reports: selectedReports.map(report => report.id),
        dealerCodes: account.dealerCodes,
        taskCount: tasks.length,
        resumed: canResume,
        startIndex: resumeIndex,
        tasksToRun: pendingIndexes.length
      });

      if (checkpoint && staleReason) {
        logger.info(`${account.logPrefix} ignoring stale checkpoint; running the full task list`, {
          mode,
          checkpoint: checkpointName,
          reason: staleReason,
          runDate,
          checkpointRunDate: checkpoint.runDate ?? null,
          checkpointUpdatedAt: checkpoint.updatedAt ?? null,
          checkpointNextIndex: checkpoint.nextIndex ?? null,
          tasksToRun: tasks.length
        });
      } else if (canResume) {
        logger.info(`${account.logPrefix} resuming from checkpoint`, {
          mode,
          checkpoint: checkpointName,
          runDate,
          resumeIndex,
          retryTaskCount: retryIndexes.length,
          retryTasks: retryIndexes.map(index => taskKeys[index]),
          tasksToRun: pendingIndexes.length,
          alreadyCompletedTaskCount: tasks.length - pendingIndexes.length
        });
      }

      for (let position = 0; position < pendingIndexes.length; position += 1) {
        const index = pendingIndexes[position];
        const { report, dealerCode } = tasks[index];
        if (position === 0 || tasks[pendingIndexes[position - 1]]?.report.id !== report.id) {
          const dealerCodes = dealerCodesForReport(report, account);
          logger.info(`${account.logPrefix} report batch started`, {
            reportId: report.id,
            report: report.name,
            dealerCodes
          });
        }

        try {
          activeDealerCode = await switchDealerIfNeeded(session.page, dealerCode, activeDealerCode);
        } catch (error) {
          logger.error(`${account.logPrefix} dealer change failed; skipping this dealer/report pair`, {
            reportId: report.id,
            report: report.name,
            dealerCode,
            currentUrl: session.page.url(),
            err: serializeError(error)
          });
          reportResults.push({
            status: 'failed',
            reportId: report.id,
            report: report.name,
            dealerCode,
            phase: 'dealer-change',
            currentUrl: session.page.url(),
            error: serializeError(error)
          });
          activeDealerCode = null;
          failedIndexes.add(index);
          nextIndex = Math.max(nextIndex, index + 1);
          await saveCheckpoint({
            reportId: report.id,
            dealerCode,
            phase: 'dealer-change'
          });
          if (isBrowserClosedError(error)) {
            logger.error(`${account.logPrefix} browser/session closed during dealer change; aborting remaining tasks`, {
              reportId: report.id,
              dealerCode
            });
            break;
          }
          continue;
        }

        const result = await runReportForDealer(session.page, report, dealerCode);
        reportResults.push(result);
        nextIndex = Math.max(nextIndex, index + 1);
        if (result.status === 'failed') {
          failedIndexes.add(index);
          await saveCheckpoint({
            reportId: report.id,
            dealerCode,
            phase: result.phase ?? 'report-run'
          });
          if (isBrowserClosedError(result.error)) {
            logger.error(`${account.logPrefix} browser/session closed during report execution; aborting remaining tasks`, {
              reportId: report.id,
              dealerCode
            });
            break;
          }
        } else {
          failedIndexes.delete(index);
          await saveCheckpoint();
        }

        if (position === pendingIndexes.length - 1 || tasks[pendingIndexes[position + 1]]?.report.id !== report.id) {
          logger.info(`${account.logPrefix} report batch finished`, {
          reportId: report.id,
          report: report.name,
          successCount: reportResults.filter(result => result.reportId === report.id && result.status === 'success').length,
          failureCount: reportResults.filter(result => result.reportId === report.id && result.status === 'failed').length
        });
        }
      }

      const failedReports = reportResults.filter(result => result.status === 'failed');
      const successfulReports = reportResults.filter(result => result.status === 'success');

      const unattemptedTaskCount = Math.max(0, tasks.length - nextIndex);

      // Cleared whenever the loop reached the end of the task list, failures included - a spent
      // checkpoint must not narrow the next scheduled run of the same day to a retry-only pass.
      if (!unattemptedTaskCount) {
        await clearCheckpoint(checkpointName);
      } else {
        logger.info(`${account.logPrefix} checkpoint kept so the next run retries what did not finish`, {
          mode,
          checkpoint: checkpointName,
          runDate,
          failedTaskCount: failedIndexes.size,
          unattemptedTaskCount,
          failedTasks: [...failedIndexes].sort((a, b) => a - b).map(index => taskKeys[index])
        });
      }

      if (account.id === 'am-platinum' && failedReports.length === 0) {
        logger.info(`${account.logPrefix} all imports completed successfully; refreshing Platinum materialized views`);
        await refreshAmPlatinumMaterializedViews();
        logger.info(`${account.logPrefix} Platinum materialized views refreshed after successful imports`);
      } else if (account.id === 'am-platinum' && failedReports.length > 0) {
        logger.warn(`${account.logPrefix} skipping Platinum materialized view refresh because one or more imports failed`, {
          failureCount: failedReports.length
        });
      }

      logger.info(`${account.logPrefix} report automation job finished`, {
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
        dealerCodes: account.dealerCodes,
        reports: reportResults,
        failedReports
      });
    } catch (error) {
      logger.error(`${account.logPrefix} report automation job failed`, {
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
      await session?.close?.().catch(() => {});
      running = false;
    }
  }

  function parseCronSchedules(cronScheduleStr) {
    if (!cronScheduleStr) return [];
    const results = [];
    for (const expr of cronScheduleStr.split('|').map(s => s.trim()).filter(Boolean)) {
      const parts = expr.split(',').map(s => s.trim()).filter(Boolean);
      let buf = '';
      for (const part of parts) {
        const test = buf ? `${buf},${part}` : part;
        const segments = test.split(/\s+/).filter(Boolean);
        if (segments.length >= 5) {
          results.push(test);
          buf = '';
        } else {
          buf = test;
        }
      }
      if (buf) results.push(buf);
    }
    return results;
  }

  function schedule() {
    const schedules = parseCronSchedules(account.cronSchedule);
    for (const schedulePattern of schedules) {
      logger.info(`Scheduling ${account.logPrefix} report automation job`, {
        cron: schedulePattern,
        mode: account.defaultMode,
        dealerCodes: account.dealerCodes,
        reportsToRun: account.reportsToRun
      });
      cron.schedule(
        schedulePattern,
        () => run(account.defaultMode),
        { timezone: account.cronTimezone ?? config.kiaCronTimezone }
      );
    }
  }

  function runFromCliIfNeeded(metaUrl, argvPath) {
    const resolvedPath = process.env.pm_exec_path || argvPath;
    const isMain = resolvedPath && metaUrl.endsWith(path.basename(resolvedPath));
    const shouldRunFromCli = isMain || process.argv.includes('--scheduler');

    if (shouldRunFromCli && process.argv.includes('--once')) {
      return run(getCliMode(account.defaultMode));
    }

    if (shouldRunFromCli) {
      schedule();
    }

    return null;
  }

  return {
    run,
    schedule,
    runFromCliIfNeeded
  };
}
