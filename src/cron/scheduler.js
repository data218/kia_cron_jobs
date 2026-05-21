import cron from 'node-cron';
import { config } from '../config.js';
import { loginToKiaDms } from '../auth/login.js';
import {
  createBrowserSessionWithState,
  createCdpBrowserSession,
  createPersistentBrowserSession
} from '../playwright/browser.js';
import { runConfiguredReports, selectedReportsRequireKiaDms } from '../reports/index.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

let running = false;

export async function runKiaDmsJob() {
  if (running) {
    logger.warn('Previous KIA DMS job is still running; skipping this tick');
    return;
  }

  running = true;
  let session;

  try {
    logger.info('Report automation job started');
    const requiresKiaDms = selectedReportsRequireKiaDms();

    if (requiresKiaDms) {
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

    const reports = await runConfiguredReports(session.page);
    logger.info('Configured reports completed', {
      count: reports.length,
      reports: reports.map(report => ({
        name: report.name,
        sheetName: report.sheetName,
        dbAction: report.dbResult?.action,
        rowCount: report.dbResult?.rowCount
      }))
    });

    logger.info('Report automation job finished');
  } catch (error) {
    logger.error('Report automation job failed', error);
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

if (process.argv.includes('--once')) {
  await runKiaDmsJob();
} else {
  logger.info('Scheduling report automation job', { cron: config.cronSchedule });
  cron.schedule(config.cronSchedule, runKiaDmsJob);
}
