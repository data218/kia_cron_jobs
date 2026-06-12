import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { loginToHmilDms } from '../auth/hmil-login.js';
import { getSelectedHmilReports } from '../reports/hmil-reports.js';
import { changeActiveDealerForDms } from '../navigation/dealer-change.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { executeWithRetry } from '../utils/execute-with-retry.js';
import { waitForConnectivity } from '../utils/network.js';

function getCliMode(defaultMode) {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='));
  return modeArg ? modeArg.slice('--mode='.length) : defaultMode;
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
          attempts: config.loginRetries + 1,
          delayMs: config.retryDelayMs,
          label: `${account.logPrefix} DMS login`
        }
      );

      const selectedReports = getSelectedHmilReports(mode, account);
      const dealerCodes = account.dealerCodes.length ? account.dealerCodes : ['active'];
      const reportResults = [];
      let activeDealerCode = null;

      logger.info(`${account.logPrefix} reports selected`, {
        mode,
        reportCount: selectedReports.length,
        reports: selectedReports.map(report => report.id),
        dealerCodes
      });

      for (const report of selectedReports) {
        logger.info(`${account.logPrefix} report batch started`, {
          reportId: report.id,
          report: report.name,
          dealerCodes
        });

        for (const dealerCode of dealerCodes) {
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
            continue;
          }

          reportResults.push(await runReportForDealer(session.page, report, dealerCode));
        }

        logger.info(`${account.logPrefix} report batch finished`, {
          reportId: report.id,
          report: report.name,
          successCount: reportResults.filter(result => result.reportId === report.id && result.status === 'success').length,
          failureCount: reportResults.filter(result => result.reportId === report.id && result.status === 'failed').length
        });
      }

      const failedReports = reportResults.filter(result => result.status === 'failed');
      const successfulReports = reportResults.filter(result => result.status === 'success');

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
        dealerCodes,
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

  function schedule() {
    logger.info(`Scheduling ${account.logPrefix} report automation job`, {
      cron: account.cronSchedule,
      mode: account.defaultMode,
      dealerCodes: account.dealerCodes,
      reportsToRun: account.reportsToRun
    });
    cron.schedule(account.cronSchedule, () => run(account.defaultMode));
  }

  function runFromCliIfNeeded(metaUrl, argvPath) {
    const isMain = argvPath && metaUrl.endsWith(path.basename(argvPath));
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
