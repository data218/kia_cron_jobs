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
import { runConfiguredReports, selectedReportsRequireKiaDmsForMode } from '../reports/index.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { ensureRuntimeDirs } from '../utils/runtime-dirs.js';
import { writeHealthStatus } from '../utils/health.js';
import { waitForConnectivity } from '../utils/network.js';

let running = false;

export async function runKiaDmsJob(mode = 'configured') {
  if (running) {
    logger.warn('Scheduler already running, skipping overlapping execution', { mode });
    return;
  }

  running = true;
  let session;
  const startedAt = Date.now();

  try {
    await ensureRuntimeDirs();
    logger.info('Report automation job started', { mode });
    await waitForConnectivity({ label: `scheduler ${mode} startup` });
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
        session = await createPersistentBrowserSession(config.rsaUserDataDir);
      } else {
        session = await createBrowserSessionWithState(config.rsaSessionStatePath);
      }
    }

    const reports = await runConfiguredReports(session.page, { mode });
    logger.info('Configured reports completed', {
      count: reports.length,
      reports: reports.map(report => ({
        name: report.name,
        sheetName: report.sheetName,
        dbAction: report.dbResult?.action,
        rowCount: report.dbResult?.rowCount
      }))
    });

    const failedReports = reports.filter(report => report.failed);
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

const shouldRunFromCli = isMainModule() || process.argv.includes('--scheduler');

if (shouldRunFromCli && process.argv.includes('--once')) {
  await runKiaDmsJob(modeFromArgs());
} else if (shouldRunFromCli) {
  logger.info('Scheduling regular report automation job', {
    cron: config.regularReportsCronSchedule,
    mode: 'regular'
  });
  cron.schedule(config.regularReportsCronSchedule, () => runKiaDmsJob('regular'));

  logger.info('Scheduling Open RO Yearly automation job', {
    cron: config.openRoYearlyCronSchedule,
    mode: 'open-ro-yearly'
  });
  cron.schedule(config.openRoYearlyCronSchedule, () => runKiaDmsJob('open-ro-yearly'));
}
