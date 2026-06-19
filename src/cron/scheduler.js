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

  if (!dealerScopedReports.length) {
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
      reports: dealerScopedReports
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
      reports: dealerScopedReports
    });
    allReports.push(...primaryOnlyReports);
    await runStandaloneReportsOnce();
    return allReports;
  }

  if (!requiresKiaDms || !config.multiDealerEnabled || !config.additionalDealerCodes.length) {
    const reports = await runConfiguredReports(page, {
      mode,
      reports: dealerScopedReports
    });
    allReports.push(...reports);
    await runStandaloneReportsOnce();
    return allReports;
  }

  if (config.multiDealerExecutionStrategy === 'report-first') {
    logger.info('Running multi-dealer reports with report-first strategy', {
      mode,
      dealerScopedReports: dealerScopedReports.map(report => report.id),
      dealers: [config.primaryDealerCode || 'current', ...config.additionalDealerCodes]
    });
    allReports.push(...await runMultiDealerReportFirst(page, {
      mode,
      reports: dealerScopedReports
    }));
  } else {
    logger.info('Running multi-dealer reports with dealer-first strategy', {
      mode,
      dealerScopedReports: dealerScopedReports.map(report => report.id),
      dealers: [config.primaryDealerCode || 'current', ...config.additionalDealerCodes],
      strategy: config.multiDealerExecutionStrategy
    });
    allReports.push(...await runMultiDealerDealerFirst(page, {
      mode,
      reports: dealerScopedReports
    }));
  }

  await runStandaloneReportsOnce();
  return allReports;
}

async function runKiaDmsJobUnlocked(mode = 'configured') {
  if (running) {
    if (!queuedModes.includes(mode)) {
      queuedModes.push(mode);
    }

    logger.warn('Scheduler already running, queued execution', {
      mode,
      queueLength: queuedModes.length,
      queuedModes
    });
    return;
  }

  running = true;
  let session;
  const startedAt = Date.now();
  let jobFailed = false;

  try {
    await ensureRuntimeDirs();
    logger.info('Report automation job started', { mode });
    await waitForConnectivity({
      label: `scheduler ${mode} startup`,
      timeoutMs: config.networkStartupWaitTimeoutMs,
      failOpen: config.networkStartupFailOpen
    });
    await writeHealthStatus({
      status: 'running',
      mode,
      startedAt: new Date(startedAt).toISOString()
    });
    const requiresKiaDms = selectedReportsRequireKiaDmsForMode(mode);

    if (config.dryRunReports) {
      logger.warn('DRY_RUN_REPORTS enabled; skipping browser login/session creation', { mode });
      session = {
        page: null,
        close: async () => {}
      };
    } else if (requiresKiaDms) {
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

    const reports = await runReportsForDealerSequence(session.page, {
      mode,
      requiresKiaDms
    });
    logger.info('Configured reports completed', {
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
        failedReportCount: failedReports.length,
        failedReports: failedReports.map(report => report.name)
      });
    } else {
      logger.warn('Skipping dashboard materialized view refresh because DRY_RUN_REPORTS is enabled');
    }

    logger.info('Report automation job finished', {
      failedReportCount: failedReports.length
    });
    await writeHealthStatus({
      status: failedReports.length ? 'completed_with_failures' : 'success',
      mode,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      reports,
      failedReports: failedReports.map(report => report.name)
    });
  } catch (error) {
    jobFailed = true;
    if (error?.name === 'NetworkUnavailableError' && mode === 'regular') {
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
      mode,
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
          mode,
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

function queueKiaDmsJob(mode, reason) {
  if (mode === 'regular' && config.skipRegularRunWhenSchedulerBusy) {
    logger.warn('Scheduler busy; skipping regular report execution', {
      mode,
      queuedModes,
      reason
    });
    return false;
  }

  if (!queuedModes.includes(mode)) {
    queuedModes.push(mode);
  }

  logger.warn('Scheduler busy; queued execution', {
    mode,
    queueLength: queuedModes.length,
    queuedModes,
    reason
  });
  return true;
}

export async function runKiaDmsJob(mode = 'configured') {
  if (running) {
    queueKiaDmsJob(mode, 'another KIA scheduler job is already running');
    return;
  }

  const lockDir = path.join(config.tempDir, 'kia-scheduler.lock');
  // Regular hourly runs can wait for an in-progress job (catch-up or prior cron).
  const lockTimeoutMs = mode === 'regular' ? 2700000 : 120000;

  try {
    return await withDirectoryLock(
      lockDir,
      () => runKiaDmsJobUnlocked(mode),
      {
        label: `kia-scheduler-${mode}`,
        timeoutMs: lockTimeoutMs,
        staleMs: 21600000,
        pollMs: 500
      }
    );
  } catch (error) {
    if (error.message?.includes('Timed out waiting for filesystem lock')) {
      queueKiaDmsJob(mode, 'filesystem lock is held by another scheduler run');
      return;
    }

    throw error;
  }
}

function modeFromArgs() {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='));
  return modeArg ? modeArg.split('=')[1] : 'configured';
}

function isMainModule() {
  if (!process.argv[1]) return false;

  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
}

const shouldRunFromCli = isMainModule();

if (shouldRunFromCli && process.argv.includes('--once')) {
  await runKiaDmsJob(modeFromArgs());
} else if (shouldRunFromCli) {
  const cronOptions = { timezone: config.kiaCronTimezone };

  logger.info('Scheduling regular report automation job', {
    cron: config.regularReportsCronSchedule,
    mode: 'regular',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.regularReportsCronSchedule, () => runKiaDmsJob('regular'), cronOptions);

  logger.info('Scheduling RSA Report automation job', {
    cron: config.rsaReportCronSchedule,
    mode: 'rsa-report',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.rsaReportCronSchedule, () => runKiaDmsJob('rsa-report'), cronOptions);

  logger.info('Scheduling Open RO Yearly automation job', {
    cron: config.openRoYearlyCronSchedule,
    mode: 'open-ro-yearly',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.openRoYearlyCronSchedule, () => runKiaDmsJob('open-ro-yearly'), cronOptions);

  logger.info('Scheduling Kia Call Center Complaints automation job', {
    cron: config.kiaCallCenterComplaintsCronSchedule,
    mode: 'kia-call-center-complaints',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.kiaCallCenterComplaintsCronSchedule, () => runKiaDmsJob('kia-call-center-complaints'), cronOptions);

  logger.info('Scheduling Demo Job Cards automation job', {
    cron: config.demoJobCardsCronSchedule,
    mode: 'demo-job-cards',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.demoJobCardsCronSchedule, () => runKiaDmsJob('demo-job-cards'), cronOptions);

  logger.info('Scheduling Demo Car List automation job', {
    cron: config.demoCarListCronSchedule,
    mode: 'demo-car-list',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.demoCarListCronSchedule, () => runKiaDmsJob('demo-car-list'), cronOptions);

  logger.info('Scheduling RO Billing automation job', {
    cron: config.roBillingCronSchedule,
    mode: 'ro-billing',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.roBillingCronSchedule, () => runKiaDmsJob('ro-billing'), cronOptions);

  logger.info('Scheduling Hyundai Repair Order automation job', {
    cron: config.hmilRepairOrderCronSchedule,
    mode: 'hyundai-repair-order',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.hmilRepairOrderCronSchedule, () => runKiaDmsJob('hyundai-repair-order'), cronOptions);

  logger.info('Scheduling Service Appointment automation job', {
    cron: config.serviceAppointmentCronSchedule,
    mode: 'service-appointment',
    timezone: config.kiaCronTimezone
  });
  cron.schedule(config.serviceAppointmentCronSchedule, () => runKiaDmsJob('service-appointment'), cronOptions);

  await writeHealthStatus({
    status: 'idle',
    mode: 'scheduler',
    startedAt: new Date().toISOString()
  });
}
