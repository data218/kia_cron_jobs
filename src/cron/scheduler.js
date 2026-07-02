import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { loginToKiaDms } from '../auth/login.js';
import {
  createBrowserSessionWithState,
  createCdpBrowserSession,
  createPersistentBrowserSession
} from '../playwright/browser.js';
import { getSelectedReports, runConfiguredReports, selectedReportsRequireKiaDmsForMode } from '../reports/index.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { ensureRuntimeDirs } from '../utils/runtime-dirs.js';
import { writeHealthStatus } from '../utils/health.js';
import { waitForConnectivity } from '../utils/network.js';
import { refreshDashboardMaterializedViews } from '../supabase/materialized-views.js';
import { changeActiveDealer } from '../navigation/dealer-change.js';
import { withDirectoryLock } from '../utils/file-lock.js';

let running = false;
const queuedModes = [];

function normalizeModeList(modeInput = 'configured') {
  if (Array.isArray(modeInput)) {
    return modeInput
      .flatMap(item => String(item).split(','))
      .map(item => item.trim())
      .filter(Boolean);
  }

  return String(modeInput)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function appendQueuedModes(modeInput, reason) {
  const modes = normalizeModeList(modeInput);

  for (const mode of modes) {
    if (mode === 'regular' && config.skipRegularRunWhenSchedulerBusy) {
      logger.warn('Scheduler busy; skipping regular report execution', {
        mode,
        queuedModes,
        reason
      });
      continue;
    }

    if (!queuedModes.includes(mode)) {
      queuedModes.push(mode);
    }
  }

  logger.warn('Scheduler busy; queued execution', {
    requestedModes: modes,
    queueLength: queuedModes.length,
    queuedModes,
    reason
  });
}

function hasFailedReports(reports) {
  return reports.some(report => report.failed);
}

async function runMultiDealerReportFirst(page, { mode, reports }) {
  const allReports = [];
  let activeDealerCode = config.primaryDealerCode || 'current';

  try {
    for (const report of reports) {
      const reportName = report.name;
      const primaryDealerReports = [];

      if (config.primaryDealerCode && activeDealerCode !== config.primaryDealerCode) {
        logger.info('Switching to primary dealer for report-first execution', {
          mode,
          report: reportName,
          dealerCode: config.primaryDealerCode
        });
        await changeActiveDealer(page, config.primaryDealerCode);
        activeDealerCode = config.primaryDealerCode;
      } else if (config.primaryDealerCode) {
        logger.info('Primary dealer already active after login; skipping dealer change', {
          mode,
          report: reportName,
          dealerCode: config.primaryDealerCode
        });
      }

      const primaryReports = await runConfiguredReports(page, {
        mode,
        dealerCode: activeDealerCode,
        reports: [report]
      });
      primaryDealerReports.push(...primaryReports);
      allReports.push(...primaryReports);

      if (hasFailedReports(primaryDealerReports)) {
        logger.warn('Skipping additional dealers for failed primary report', {
          mode,
          report: reportName,
          dealerCode: activeDealerCode,
          failedReports: primaryDealerReports.filter(item => item.failed).map(item => item.name)
        });
        continue;
      }

      for (const dealerCode of config.additionalDealerCodes) {
        if (activeDealerCode === dealerCode) {
          logger.info('Additional dealer already active; skipping dealer change', {
            mode,
            report: reportName,
            dealerCode
          });
        } else {
          logger.info('Switching to additional dealer for same report', {
            mode,
            report: reportName,
            dealerCode
          });
          await changeActiveDealer(page, dealerCode);
          activeDealerCode = dealerCode;
        }

        const dealerReports = await runConfiguredReports(page, {
          mode,
          dealerCode,
          reports: [report]
        });
        allReports.push(...dealerReports);

        if (hasFailedReports(dealerReports)) {
          logger.warn('Stopping additional dealer execution for failed report', {
            mode,
            report: reportName,
            dealerCode,
            failedReports: dealerReports.filter(item => item.failed).map(item => item.name)
          });
          break;
        }
      }
    }

    return allReports;
  } finally {
    if (config.primaryDealerCode && activeDealerCode !== config.primaryDealerCode) {
      logger.info('Restoring primary dealer after report-first multi-dealer run', {
        mode,
        dealerCode: config.primaryDealerCode,
        previousDealerCode: activeDealerCode
      });
      try {
        await changeActiveDealer(page, config.primaryDealerCode);
      } catch (error) {
        logger.warn('Failed to restore primary dealer after report-first multi-dealer run', {
          mode,
          dealerCode: config.primaryDealerCode,
          err: {
            name: error.name,
            message: error.message
          }
        });
      }
    }
  }
}

async function runMultiDealerDealerFirst(page, { mode, reports }) {
  const allReports = [];
  let activeDealerCode = config.primaryDealerCode || 'current';

  try {
    if (config.primaryDealerCode) {
      logger.info('Assuming primary dealer is active after login; skipping initial dealer change', {
        mode,
        dealerCode: config.primaryDealerCode
      });
    }

    const primaryReports = await runConfiguredReports(page, {
      mode,
      dealerCode: activeDealerCode,
      reports
    });
    allReports.push(...primaryReports);

    if (hasFailedReports(primaryReports)) {
      logger.warn('Skipping additional dealer execution because primary dealer reports failed', {
        mode,
        dealerCode: activeDealerCode,
        failedReports: primaryReports.filter(report => report.failed).map(report => report.name)
      });
    } else {
      for (const dealerCode of config.additionalDealerCodes) {
        if (activeDealerCode === dealerCode) {
          logger.info('Additional dealer already active; skipping dealer change', { mode, dealerCode });
        } else {
          logger.info('Starting additional dealer execution', { mode, dealerCode });
          await changeActiveDealer(page, dealerCode);
          activeDealerCode = dealerCode;
        }

        const dealerReports = await runConfiguredReports(page, {
          mode,
          dealerCode,
          reports
        });
        allReports.push(...dealerReports);

        if (hasFailedReports(dealerReports)) {
          logger.warn('Stopping additional dealer sequence because dealer reports failed', {
            mode,
            dealerCode,
            failedReports: dealerReports.filter(report => report.failed).map(report => report.name)
          });
          break;
        }
      }
    }

    return allReports;
  } finally {
    if (config.primaryDealerCode && activeDealerCode !== config.primaryDealerCode) {
      logger.info('Restoring primary dealer after multi-dealer run', {
        mode,
        dealerCode: config.primaryDealerCode,
        previousDealerCode: activeDealerCode
      });
      try {
        await changeActiveDealer(page, config.primaryDealerCode);
      } catch (error) {
        logger.warn('Failed to restore primary dealer after multi-dealer run', {
          mode,
          dealerCode: config.primaryDealerCode,
          err: {
            name: error.name,
            message: error.message
          }
        });
      }
    }
  }
}

async function runReportsForDealerSequence(page, { mode, requiresKiaDms }) {
  const selectedReports = getSelectedReports({ mode });
  const dealerScopedReports = selectedReports.filter(report => report.requiresKiaDms);
  const standaloneReports = selectedReports.filter(report => !report.requiresKiaDms);
  const allReports = [];

  async function runStandaloneReportsOnce() {
    if (!standaloneReports.length) {
      return [];
    }

    logger.info('Running standalone reports once outside dealer loop', {
      mode,
      reports: standaloneReports.map(report => report.id)
    });

    const reports = await runConfiguredReports(page, {
      mode,
      dealerCode: 'standalone',
      reports: standaloneReports
    });
    allReports.push(...reports);
    return reports;
  }

  // Filter out reports that should not undergo dealer switching
  const noSwitchReports = dealerScopedReports.filter(report => report.noDealerSwitch);
  const switchReports = dealerScopedReports.filter(report => !report.noDealerSwitch);

  if (noSwitchReports.length) {
    logger.info('Running reports without dealer switching (using active default dealer)', {
      mode,
      reports: noSwitchReports.map(report => report.id)
    });
    const reportsRun = await runConfiguredReports(page, {
      mode,
      dealerCode: 'active',
      reports: noSwitchReports
    });
    allReports.push(...reportsRun);
  }

  if (!switchReports.length) {
    await runStandaloneReportsOnce();
    return allReports;
  }

  if (requiresKiaDms && config.forceActiveDealerCode) {
    logger.info('Forcing active dealer before report sequence', {
      mode,
      dealerCode: config.forceActiveDealerCode
    });
    await changeActiveDealer(page, config.forceActiveDealerCode);

    const forcedDealerReports = await runConfiguredReports(page, {
      mode,
      dealerCode: config.forceActiveDealerCode,
      reports: switchReports
    });
    allReports.push(...forcedDealerReports);
    await runStandaloneReportsOnce();
    return allReports;
  }

  if (requiresKiaDms && config.primaryDealerOnlyModes.includes(mode)) {
    if (config.primaryDealerCode) {
      logger.info('Running primary-dealer-only report mode', {
        mode,
        dealerCode: config.primaryDealerCode
      });
      await changeActiveDealer(page, config.primaryDealerCode);
    } else {
      logger.info('Running primary-dealer-only report mode with current active dealer', { mode });
    }

    const primaryOnlyReports = await runConfiguredReports(page, {
      mode,
      dealerCode: config.primaryDealerCode || undefined,
      reports: switchReports
    });
    allReports.push(...primaryOnlyReports);
    await runStandaloneReportsOnce();
    return allReports;
  }

  if (!requiresKiaDms || !config.multiDealerEnabled || !config.additionalDealerCodes.length) {
    const reports = await runConfiguredReports(page, {
      mode,
      reports: switchReports
    });
    allReports.push(...reports);
    await runStandaloneReportsOnce();
    return allReports;
  }

  if (config.multiDealerExecutionStrategy === 'report-first') {
    logger.info('Running multi-dealer reports with report-first strategy', {
      mode,
      dealerScopedReports: switchReports.map(report => report.id),
      dealers: [config.primaryDealerCode || 'current', ...config.additionalDealerCodes]
    });
    allReports.push(...await runMultiDealerReportFirst(page, {
      mode,
      reports: switchReports
    }));
  } else {
    logger.info('Running multi-dealer reports with dealer-first strategy', {
      mode,
      dealerScopedReports: switchReports.map(report => report.id),
      dealers: [config.primaryDealerCode || 'current', ...config.additionalDealerCodes],
      strategy: config.multiDealerExecutionStrategy
    });
    allReports.push(...await runMultiDealerDealerFirst(page, {
      mode,
      reports: switchReports
    }));
  }

  await runStandaloneReportsOnce();
  return allReports;
}

async function runKiaDmsJobUnlocked(modeInput = 'configured') {
  const requestedModes = normalizeModeList(modeInput);
  const initialMode = requestedModes[0] || 'configured';

  if (running) {
    appendQueuedModes(requestedModes, 'another KIA scheduler job is already running');
    return;
  }

  running = true;
  let session;
  const startedAt = Date.now();
  let jobFailed = false;
  const localQueuedModes = requestedModes.slice(1);
  const modeLabel = requestedModes.join(',');

  try {
    await ensureRuntimeDirs();
    logger.info('Report automation job started', {
      mode: initialMode,
      requestedModes
    });
    await waitForConnectivity({
      label: `scheduler ${initialMode} startup`,
      timeoutMs: config.networkStartupWaitTimeoutMs,
      failOpen: config.networkStartupFailOpen
    });

    let currentMode = initialMode;
    let currentModeRequiresKiaDms = selectedReportsRequireKiaDmsForMode(currentMode);

    if (config.dryRunReports) {
      logger.warn('DRY_RUN_REPORTS enabled; skipping browser login/session creation', { mode: currentMode });
      session = {
        page: null,
        close: async () => {}
      };
    } else if (currentModeRequiresKiaDms) {
      session = await retry(
        async () => loginToKiaDms(),
        {
          attempts: config.loginRetries + 1,
          delayMs: config.retryDelayMs,
          label: 'KIA DMS login'
        }
      );
    } else {
      logger.info('Selected reports do not require KIA DMS login; opening browser session directly');
      if (config.rsaCdpEndpoint) {
        session = await createCdpBrowserSession(config.rsaCdpEndpoint);
      } else if (config.rsaUsePersistentProfile) {
        session = await createPersistentBrowserSession(config.rsaUserDataDir, {
          headless: config.rsaHeadless
        });
      } else {
        session = await createBrowserSessionWithState(config.rsaSessionStatePath, {
          headless: config.rsaHeadless
        });
      }
    }

    while (currentMode) {
      const modeStartedAt = Date.now();
      await writeHealthStatus({
        status: 'running',
        mode: currentMode,
        startedAt: new Date(modeStartedAt).toISOString()
      });
      const requiresKiaDms = selectedReportsRequireKiaDmsForMode(currentMode);

      if (requiresKiaDms !== currentModeRequiresKiaDms && !config.dryRunReports) {
        logger.info('Session requirement changed; recreating session', {
          oldMode: currentMode,
          requiresKiaDms
        });
        if (session?.close) {
          await session.close().catch(() => {});
        } else {
          await session?.browser?.close().catch(() => {});
        }

        currentModeRequiresKiaDms = requiresKiaDms;
        if (currentModeRequiresKiaDms) {
          session = await retry(
            async () => loginToKiaDms(),
            {
              attempts: config.loginRetries + 1,
              delayMs: config.retryDelayMs,
              label: 'KIA DMS login'
            }
          );
        } else {
          if (config.rsaCdpEndpoint) {
            session = await createCdpBrowserSession(config.rsaCdpEndpoint);
          } else if (config.rsaUsePersistentProfile) {
            session = await createPersistentBrowserSession(config.rsaUserDataDir, {
              headless: config.rsaHeadless
            });
          } else {
            session = await createBrowserSessionWithState(config.rsaSessionStatePath, {
              headless: config.rsaHeadless
            });
          }
        }
      }

      const reports = await runReportsForDealerSequence(session.page, {
        mode: currentMode,
        requiresKiaDms
      });
      logger.info('Configured reports completed', {
        mode: currentMode,
        count: reports.length,
        reports: reports.map(report => ({
          name: report.name,
          dealerCode: report.dealerCode,
          sheetName: report.sheetName,
          dbAction: report.dbResult?.action,
          rowCount: report.dbResult?.rowCount
        }))
      });

      const failedReports = reports.filter(report => report.failed);
      if (!failedReports.length && !config.dryRunReports) {
        logger.info('All imports completed successfully; refreshing dashboard materialized views');
        await refreshDashboardMaterializedViews();
        logger.info('Dashboard materialized views refreshed after successful imports');
      } else if (failedReports.length) {
        logger.warn('Skipping dashboard materialized view refresh because one or more imports failed', {
          mode: currentMode,
          failedReportCount: failedReports.length,
          failedReports: failedReports.map(report => report.name)
        });
      } else {
        logger.warn('Skipping dashboard materialized view refresh because DRY_RUN_REPORTS is enabled');
      }

      logger.info('Report automation job finished', {
        mode: currentMode,
        failedReportCount: failedReports.length
      });
      await writeHealthStatus({
        status: failedReports.length ? 'completed_with_failures' : 'success',
        mode: currentMode,
        startedAt: new Date(modeStartedAt).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - modeStartedAt,
        reports,
        failedReports: failedReports.map(report => report.name)
      });

      if (localQueuedModes.length > 0) {
        const nextMode = localQueuedModes.shift();
        logger.info('Continuing with next requested mode in the same browser session', {
          nextMode,
          remainingRequestedModes: localQueuedModes
        });
        currentMode = nextMode;
      } else if (queuedModes.length > 0) {
        const nextMode = queuedModes.shift();
        logger.info('Continuing with next queued mode in the same browser session', {
          nextMode,
          remainingQueueLength: queuedModes.length,
          queuedModes
        });
        currentMode = nextMode;
      } else {
        currentMode = null;
      }
    }
  } catch (error) {
    jobFailed = true;
    if (error?.name === 'NetworkUnavailableError' && initialMode === 'regular' && requestedModes.length === 1) {
      logger.warn('Scheduling delayed regular retry after startup network failure', {
        retryInMs: config.networkStartupRetryDelayMs
      });
      setTimeout(() => {
        runKiaDmsJob('regular').catch(retryError => {
          logger.error('Delayed regular retry after network failure failed', retryError);
        });
      }, config.networkStartupRetryDelayMs);
    }
    logger.error('Report automation job failed', error);
    await writeHealthStatus({
      status: 'failed',
      mode: modeLabel,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (session?.close) {
      await session.close().catch(() => {});
    } else {
      await session?.browser?.close().catch(() => {});
    }
    running = false;

    if (jobFailed && queuedModes.length) {
      const preservedModes = queuedModes.filter(queuedMode => queuedMode === 'regular');
      const droppedModes = queuedModes.filter(queuedMode => queuedMode !== 'regular');
      queuedModes.length = 0;
      queuedModes.push(...preservedModes);

      if (droppedModes.length) {
        logger.warn('Cleared queued scheduler executions because current run failed', {
          mode: modeLabel,
          droppedModes,
          preservedModes,
          reason: 'avoid repeated login/OTP attempts after a failed scheduler run'
        });
      }

      if (!preservedModes.length) {
        return;
      }
    }

    const nextMode = queuedModes.shift();
    if (nextMode) {
      logger.info('Starting queued scheduler execution', {
        mode: nextMode,
        remainingQueueLength: queuedModes.length,
        queuedModes
      });
      setImmediate(() => {
        runKiaDmsJob(nextMode).catch(error => {
          logger.error('Queued scheduler execution failed', {
            mode: nextMode,
            err: {
              name: error.name,
              message: error.message,
              stack: error.stack
            }
          });
        });
      });
    }
  }
}

export async function runKiaDmsJob(modeInput = 'configured') {
  const requestedModes = normalizeModeList(modeInput);

  if (running) {
    appendQueuedModes(requestedModes, 'another KIA scheduler job is already running');
    return;
  }

  // Use a separate lock file for RSA reports to prevent scheduling conflicts with regular Kia reports
  const isRsaOnly = requestedModes.length === 1 && requestedModes[0] === 'rsa-report';
  const lockName = isRsaOnly ? 'kia-rsa-scheduler.lock' : 'kia-scheduler.lock';
  const lockDir = path.join(config.tempDir, lockName);
  // Regular hourly runs can wait for an in-progress job (catch-up or prior cron).
  const lockTimeoutMs = requestedModes.includes('regular') || requestedModes.includes('rsa-report')
    ? 2700000
    : 120000;
  const lockLabel = `kia-scheduler-${requestedModes.join('__') || 'configured'}`;

  try {
    return await withDirectoryLock(
      lockDir,
      () => runKiaDmsJobUnlocked(requestedModes),
      {
        label: lockLabel,
        timeoutMs: lockTimeoutMs,
        staleMs: 21600000,
        pollMs: 500
      }
    );
  } catch (error) {
    if (error.message?.includes('Timed out waiting for filesystem lock')) {
      if (requestedModes.includes('rsa-report')) {
        logger.warn('RSA scheduler could not acquire filesystem lock; will retry on the next scheduled run', {
          requestedModes,
          lockTimeoutMs
        });
        return;
      }
      appendQueuedModes(requestedModes, 'filesystem lock is held by another scheduler run');
      return;
    }

    throw error;
  }
}

function modeFromArgs() {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='));
  if (modeArg) {
    return modeArg.split('=')[1];
  }

  const modesArg = process.argv.find(arg => arg.startsWith('--modes='));
  return modesArg ? modesArg.split('=')[1] : 'configured';
}

function isMainModule() {
  const argvPath = process.env.pm_exec_path || process.argv[1];
  if (!argvPath) return false;

  return path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(argvPath).toLowerCase();
}

const shouldRunFromCli = isMainModule();

if (shouldRunFromCli && process.argv.includes('--once')) {
  await runKiaDmsJob(modeFromArgs());
} else if (shouldRunFromCli) {
  const cronOptions = { timezone: config.kiaCronTimezone };

  function scheduleCronJob(cronScheduleStr, taskFn, label) {
    const parts = (cronScheduleStr || '').split(',').map(s => s.trim()).filter(Boolean);
    const schedules = [];
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
    for (const schedule of schedules) {
      logger.info(`Scheduling ${label} automation job`, {
        cron: schedule,
        timezone: cronOptions.timezone
      });
      cron.schedule(schedule, taskFn, cronOptions);
    }
  }

  scheduleCronJob(config.regularReportsCronSchedule, () => runKiaDmsJob('regular'), 'regular');
  
  // Only schedule RSA report if we are NOT running under the main kia-cron-scheduler process.
  // This delegates RSA reports solely to the dedicated kia-rsa-cron-job PM2 process.
  if (process.env.LOG_SERVICE_NAME !== 'kia-cron-scheduler') {
    scheduleCronJob(config.rsaReportCronSchedule, () => runKiaDmsJob('rsa-report'), 'rsa-report');
  }

  scheduleCronJob(config.openRoYearlyCronSchedule, () => runKiaDmsJob('open-ro-yearly'), 'open-ro-yearly');
  scheduleCronJob(config.kiaCallCenterComplaintsCronSchedule, () => runKiaDmsJob('kia-call-center-complaints'), 'kia-call-center-complaints');
  scheduleCronJob(config.demoJobCardsCronSchedule, () => runKiaDmsJob('demo-job-cards'), 'demo-job-cards');
  scheduleCronJob(config.demoCarListCronSchedule, () => runKiaDmsJob('demo-car-list'), 'demo-car-list');
  scheduleCronJob(config.roBillingCronSchedule, () => runKiaDmsJob('ro-billing'), 'ro-billing');
  scheduleCronJob(config.serviceAppointmentCronSchedule, () => runKiaDmsJob('service-appointment'), 'service-appointment');
  scheduleCronJob(config.kiaBookingReportCronSchedule, () => runKiaDmsJob('kia-booking-report'), 'kia-booking-report');
  scheduleCronJob(config.kiaSalesReportCronSchedule, () => runKiaDmsJob('kia-sales-report'), 'kia-sales-report');
  scheduleCronJob(config.kiaEnquiryReportCronSchedule, () => runKiaDmsJob('kia-enquiry-report'), 'kia-enquiry-report');
  scheduleCronJob(
    config.kiaAccessoriesCounterSalesCronSchedule,
    () => runKiaDmsJob('kia-accessories-counter-sales-report'),
    'kia-accessories-counter-sales-report'
  );
  scheduleCronJob(config.kiaPurchaseReportCronSchedule, () => runKiaDmsJob('kia-purchase-report'), 'kia-purchase-report');
  scheduleCronJob(config.kiaStockManagementCronSchedule, () => runKiaDmsJob('kia-stock-management'), 'kia-stock-management');

  await writeHealthStatus({
    status: 'idle',
    mode: 'scheduler',
    startedAt: new Date().toISOString()
  });
}
