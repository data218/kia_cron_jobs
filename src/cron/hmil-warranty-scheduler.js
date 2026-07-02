import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmilWarrantyAccounts, createWarrantyScheduledAccounts } from '../accounts/hmil-warranty-accounts.js';
import { loginToHmilDms } from '../auth/hmil-login.js';
import { config } from '../config.js';
import { changeActiveDealerForDms } from '../navigation/dealer-change.js';
import {
  clearHmilWarrantyTables,
  clearHmilWarrantyClaimListTable,
  clearHmilWarrantyClaimListRowsByLogins,
  hmilWarrantyReportDefinitions,
  runHmilWarrantyReport
} from '../reports/hmil-warranty-reports.js';
import { executeWithRetry } from '../utils/execute-with-retry.js';
import { withDirectoryLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import { waitForConnectivity } from '../utils/network.js';
import { retry } from '../utils/retry.js';
import { isBrowserClosedError } from '../utils/failure.js';

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

function isActiveDealerAlias(dealerCode) {
  return !dealerCode || ['active', 'current', 'default'].includes(String(dealerCode).trim().toLowerCase());
}

function resolvedLoginRetries(account) {
  return Number.isInteger(account?.loginRetries)
    ? account.loginRetries
    : config.loginRetries;
}

const RAJOURI_HISTORICAL_FETCH_CODE = 'N6824';

function platinumDealersForWarrantyAccount(account) {
  const isHistorical = account?.id === 'am-platinum-warranty-historical' ||
    account?.id === 'am-platinum-historical' ||
    String(account?.userId || '').toUpperCase() === String(config.amPlatinumHistoricalUserId || 'MIS12345').toUpperCase();

  if (isHistorical) {
    // Only return the historical dealers for MIS12345
    return ['N5211', 'N6828'];
  }

  // Only return the current dealer (N6250) for MIS1988
  return [config.amPlatinumPost2024DealerCode || 'N6250'];
}

export function getWarrantyDealerCodesForAccount(account) {
  const isPlatinum = account?.id?.startsWith('am-platinum') ||
    [config.amPlatinumUserId, config.amPlatinumHistoricalUserId]
      .filter(Boolean)
      .some(userId => String(account?.userId || '').toUpperCase() === String(userId).toUpperCase());

  if (isPlatinum) {
    return platinumDealersForWarrantyAccount(account);
  }

  const isSecondary = account?.id === 'hmil-warranty-secondary' ||
    String(account?.userId || '').toUpperCase() === String(config.hmilSecondaryUserId || 'MIS5216').toUpperCase();

  if (isSecondary) {
    return config.hmilWarrantySecondaryDealerCodes.length
      ? config.hmilWarrantySecondaryDealerCodes
      : ['active'];
  }

  return config.hmilPrimaryDealerCodes.length ? config.hmilPrimaryDealerCodes : ['active'];
}

function getWarrantyDealerCodesByAccount(accounts) {
  return Object.fromEntries(
    accounts.map(account => [account.userId, getWarrantyDealerCodesForAccount(account)])
  );
}

function ensureDeadlineNotExceeded(deadlineAt, label) {
  if (!deadlineAt) return;
  if (Date.now() > deadlineAt) {
    throw new Error(`HMIL warranty max runtime exceeded while ${label}`);
  }
}

async function isLoginFormVisible(page) {
  return page.locator([
    'input[type="password"]',
    '#userId',
    '#password',
    'form[name="loginForm"]'
  ].join(',')).first().isVisible({ timeout: 1000 }).catch(() => false);
}

async function ensureWarrantyDirs(accounts) {
  await Promise.all([
    fs.mkdir(config.logsDir, { recursive: true }),
    fs.mkdir(config.screenshotsDir, { recursive: true }),
    fs.mkdir(config.tempDir, { recursive: true }),
    ...accounts.flatMap(account => [
      fs.mkdir(account.downloadDir, { recursive: true }),
      fs.mkdir(account.reportChunksDir, { recursive: true }),
      fs.mkdir(path.dirname(account.sessionStatePath), { recursive: true })
    ])
  ]);
}

async function writeWarrantyHealth(status) {
  const payload = {
    service: 'hmil-warranty-cron-job',
    env: process.env.NODE_ENV || 'development',
    updatedAt: new Date().toISOString(),
    ...status
  };
  const filePath = path.join(config.logsDir, 'hmil-warranty-health.json');
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  logger.info('HMIL warranty health status updated', {
    status: payload.status,
    filePath
  });
}

async function switchDealerIfNeeded(page, dealerCode, activeDealerCode) {
  if (isActiveDealerAlias(dealerCode)) {
    logger.info('Using current active HMIL warranty dealer; skipping dealer change');
    return activeDealerCode;
  }

  if (activeDealerCode === dealerCode) {
    logger.info('HMIL warranty dealer already active; skipping dealer change', { dealerCode });
    return activeDealerCode;
  }

  await changeActiveDealerForDms(page, dealerCode, {
    homeUrl: config.hmilHomeUrl,
    systemLabel: 'HMIL DMS'
  });
  return dealerCode;
}

export async function executeHmilWarrantySequence({
  mode,
  accounts,
  reports,
  dealerCodesByAccount = null,
  dryRun = false,
  resume = false,
  deadlineAt = null,
  login = loginToHmilDms,
  runReport = runHmilWarrantyReport
}) {
  const results = [];

  for (const account of accounts) {
    ensureDeadlineNotExceeded(deadlineAt, `starting account ${account.userId}`);
    const dealerCodes = dealerCodesByAccount?.[account.userId] ??
      getWarrantyDealerCodesForAccount(account);
    let session;
    let activeDealerCode = null;
    let accountSessionDead = false;

    logger.info('Starting all dealers for account in single session', {
      sourceLoginId: account.userId,
      dealerCodes
    });

    try {
      if (!dryRun) {
        session = await retry(
          () => login(account),
          {
            attempts: resolvedLoginRetries(account) + 1,
            delayMs: config.retryDelayMs,
            label: `${account.logPrefix} login`
          }
        );
      }

      for (const dealerCode of dealerCodes) {
        if (accountSessionDead) {
          break;
        }
        ensureDeadlineNotExceeded(deadlineAt, `starting dealer ${dealerCode} for ${account.userId}`);
        const effectiveReports = reports;

        if (effectiveReports.length === 0) {
          continue;
        }

        if (!dryRun) {
          try {
            activeDealerCode = await switchDealerIfNeeded(session.page, dealerCode, activeDealerCode);
          } catch (error) {
            const loginFormVisible = await isLoginFormVisible(session.page);
            logger.error('HMIL warranty dealer change failed; skipping this dealer', {
              sourceLoginId: account.userId,
              dealerCode,
              currentUrl: session.page.url(),
              loginFormVisible,
              err: serializeError(error)
            });
            for (const report of reports) {
              results.push({
                status: 'failed',
                phase: 'dealer-change',
                accountId: account.id,
                sourceLoginId: account.userId,
                dealerCode,
                reportId: report.id,
                report: report.name,
                error: serializeError(error)
              });
            }
            activeDealerCode = null;
            if (isBrowserClosedError(error)) {
              logger.error('HMIL warranty browser/session closed during dealer change; aborting remaining dealers for this account', {
                sourceLoginId: account.userId,
                dealerCode
              });
              accountSessionDead = true;
              break;
            }
            continue;
          }
        }

        for (const report of effectiveReports) {
          ensureDeadlineNotExceeded(deadlineAt, `starting report ${report.id} for ${dealerCode} (${account.userId})`);
          const itemStartedAt = Date.now();
          const label = `${report.name} [${account.userId}] [${dealerCode}]`;

          try {
            const result = dryRun
              ? {
                  name: report.name,
                  id: report.id,
                  sheetName: report.sheetName,
                  sourceLoginId: account.userId,
                  dealerCode,
                  dbResult: { action: 'dry-run', rowCount: 0 }
                }
              : await executeWithRetry({
                  name: label,
                  page: session.page,
                  fn: () => runReport(session.page, { account, mode, report, dealerCode, resume })
                });

            results.push({
              status: 'success',
              accountId: account.id,
              sourceLoginId: account.userId,
              dealerCode,
              reportId: report.id,
              durationMs: Date.now() - itemStartedAt,
              ...result
            });
          } catch (error) {
            logger.error('HMIL warranty account/dealer/report failed; continuing', {
              sourceLoginId: account.userId,
              dealerCode,
              reportId: report.id,
              err: serializeError(error)
            });
            results.push({
              status: 'failed',
              accountId: account.id,
              sourceLoginId: account.userId,
              dealerCode,
              reportId: report.id,
              report: report.name,
              durationMs: Date.now() - itemStartedAt,
              error: serializeError(error)
            });
            if (isBrowserClosedError(error)) {
              logger.error('HMIL warranty browser/session closed during report execution; aborting remaining work for this account', {
                sourceLoginId: account.userId,
                dealerCode,
                reportId: report.id
              });
              accountSessionDead = true;
              break;
            }
          }
        }
      }
    } catch (error) {
      logger.error('HMIL warranty account login failed; continuing with next account', {
        sourceLoginId: account.userId,
        err: serializeError(error)
      });
      for (const dealerCode of dealerCodes) {
        for (const report of reports) {
          results.push({
            status: 'failed',
            phase: 'login',
            accountId: account.id,
            sourceLoginId: account.userId,
            dealerCode,
            reportId: report.id,
            report: report.name,
            error: serializeError(error)
          });
        }
      }
    } finally {
      await session?.close?.().catch(() => {});
    }
  }

  return results;
}

export async function runHmilWarrantyJob(mode = 'scheduled', {
  accounts = mode === 'scheduled' ? createWarrantyScheduledAccounts() : createHmilWarrantyAccounts(),
  reports = hmilWarrantyReportDefinitions,
  dealerCodesByAccount = null,
  dryRun = config.dryRunReports,
  skipTableClear = mode === 'scheduled',
  resume = mode === 'scheduled' ? config.hmilWarrantyScheduledResume : config.hmilWarrantyResume
} = {}) {
  const brandFilter = brandFromArgs();
  const filteredAccounts = brandFilter
    ? accounts.filter(account => {
        const isPlatinum = account.id.startsWith('am-platinum');
        return brandFilter === 'platinum' ? isPlatinum : !isPlatinum;
      })
    : accounts;

  const lockDir = path.join(config.tempDir, 'hmil-warranty-scheduler.lock');
  const effectiveAccounts = filteredAccounts.map(account => ({
    ...account,
    headless: mode === 'historical' ? false : account.headless,
    otpProvider: mode === 'historical'
      ? config.hmilWarrantyHistoricalOtpProvider
      : 'webhook'
  }));
  const resolvedDealerCodesByAccount = dealerCodesByAccount ??
    getWarrantyDealerCodesByAccount(effectiveAccounts);

  return withDirectoryLock(lockDir, async () => {
    if (!dryRun && mode !== 'historical' && config.otpProvider !== 'webhook') {
      throw new Error('Scheduled HMIL warranty automation requires OTP_PROVIDER=webhook');
    }

    const startedAt = Date.now();
    const deadlineAt = startedAt + config.hmilWarrantyMaxRunMs;
    await ensureWarrantyDirs(effectiveAccounts);
    await waitForConnectivity({ label: `HMIL warranty ${mode} startup` });
    await writeWarrantyHealth({
      status: 'running',
      mode,
      startedAt: new Date(startedAt).toISOString(),
      accounts: effectiveAccounts.map(account => account.userId),
      dealerCodesByAccount: resolvedDealerCodesByAccount
    });

    if (!dryRun && !skipTableClear && !resume) {
      await clearHmilWarrantyTables();
    } else if ((resume || skipTableClear) && !dryRun) {
      logger.info('HMIL warranty append mode enabled; keeping existing relational tables', { mode });
    }

    if (!dryRun && reports.some(r => r.id === 'hyundai-warranty-claim-list')) {
      const selectedLogins = effectiveAccounts
        .map(account => String(account.userId || '').trim())
        .filter(Boolean);

      if (selectedLogins.length === createWarrantyScheduledAccounts().length) {
        await clearHmilWarrantyClaimListTable();
      } else {
        await clearHmilWarrantyClaimListRowsByLogins(selectedLogins);
      }
    }

    const results = await executeHmilWarrantySequence({
      mode,
      accounts: effectiveAccounts,
      reports,
      dealerCodesByAccount: resolvedDealerCodesByAccount,
      dryRun,
      resume,
      deadlineAt
    });

    const failed = results.filter(result => result.status === 'failed');
    await writeWarrantyHealth({
      status: failed.length ? 'completed_with_failures' : 'success',
      mode,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      dealerCodesByAccount: resolvedDealerCodesByAccount,
      results,
      failedCount: failed.length
    });

    if (failed.length) {
      process.exitCode = 1;
    }

    return results;
  }, {
    label: `hmil-warranty-${mode}`,
    timeoutMs: 1000,
    staleMs: 21600000,
    pollMs: 250
  });
}

function modeFromArgs() {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='));
  return modeArg ? modeArg.slice('--mode='.length) : 'scheduled';
}

function reportFromArgs() {
  const reportArg = process.argv.find(arg => arg.startsWith('--report='));
  return reportArg ? reportArg.slice('--report='.length) : null;
}

function brandFromArgs() {
  const brandArg = process.argv.find(arg => arg.startsWith('--brand='));
  return brandArg ? brandArg.slice('--brand='.length) : null;
}

function isMainModule() {
  const argvPath = process.env.pm_exec_path || process.argv[1];
  if (!argvPath) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argvPath);
}

const shouldRun = isMainModule() || process.argv.includes('--scheduler');

if (shouldRun) {
  const reportFilter = reportFromArgs();
  const reports = reportFilter
    ? hmilWarrantyReportDefinitions.filter(r => r.id === reportFilter)
    : hmilWarrantyReportDefinitions;

  if (process.argv.includes('--once')) {
    await runHmilWarrantyJob(modeFromArgs(), { reports });
  } else {
    const label = reportFilter ? reportFilter : 'all';
    const schedules = (config.hmilWarrantyCronSchedule || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const schedulePattern of schedules) {
      logger.info('Scheduling HMIL warranty automation job', {
        report: label,
        cron: schedulePattern,
        timezone: config.hmilWarrantyCronTimezone,
        startDate: config.hmilWarrantyHistoricalStartDate,
        accounts: createWarrantyScheduledAccounts().map(account => account.userId)
      });
      cron.schedule(
        schedulePattern,
        () => runHmilWarrantyJob('scheduled', { reports }).catch(error => {
          logger.error('Scheduled HMIL warranty job failed', error);
        }),
        { timezone: config.hmilWarrantyCronTimezone }
      );
    }
    await writeWarrantyHealth({
      status: 'idle',
      mode: 'scheduler',
      report: label,
      startedAt: new Date().toISOString()
    });
  }
}
