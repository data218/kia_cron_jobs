import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGdmsAccountProfile } from '../accounts/gdms-account-profile.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createGdmsAccountScheduler } from './gdms-account-scheduler.js';

const primaryAccount = createGdmsAccountProfile('hmil');
const secondaryAccount = createGdmsAccountProfile('hmil-secondary');
const primaryScheduler = createGdmsAccountScheduler(primaryAccount);
const secondaryScheduler = createGdmsAccountScheduler(secondaryAccount);

let running = false;

function selectedAccounts() {
  return [primaryAccount, secondaryAccount].filter(account => account.dealerCodes.length > 0);
}

function modeFromArgs() {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='));
  return modeArg ? modeArg.slice('--mode='.length) : primaryAccount.defaultMode;
}

export async function runHmilDmsJob(mode = primaryAccount.defaultMode) {
  if (running) {
    logger.warn('HMIL scheduler already running, skipping overlapping execution', {
      mode,
      reason: 'another HMIL scheduler run is already active'
    });
    return;
  }

  running = true;

  try {
    const accounts = selectedAccounts();
    logger.info('HMIL scheduler cycle started', {
      mode,
      accounts: accounts.map(account => ({
        id: account.id,
        userId: account.userId,
        dealerCodes: account.dealerCodes
      }))
    });

    if (accounts.some(account => account.id === primaryAccount.id) && mode !== 'hyundai-regular') {
      await primaryScheduler.run(mode);
    } else if (accounts.some(account => account.id === primaryAccount.id)) {
      logger.info('Skipping HMIL primary account (sahiltech) for regular cron run as it is historical-only');
    }

    if (accounts.some(account => account.id === secondaryAccount.id)) {
      await secondaryScheduler.run(mode);
    }

    logger.info('HMIL scheduler cycle finished', { mode });
  } finally {
    running = false;
  }
}

function isMainModule() {
  const argvPath = process.env.pm_exec_path || process.argv[1];
  if (!argvPath) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argvPath);
}

function parseCronSchedules(cronScheduleStr) {
  if (!cronScheduleStr) return [];
  // Support '|' as a top-level separator between full cron expressions
  // (e.g. "0 11 * * *|30 20 * * *") as well as comma-in-hour syntax
  // (e.g. "0 11,17 * * *") via the reassembly loop below.
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

const shouldRunFromCli = isMainModule() || process.argv.includes('--scheduler');

if (shouldRunFromCli && process.argv.includes('--once')) {
  await runHmilDmsJob(modeFromArgs());
} else if (shouldRunFromCli) {
  const schedules = parseCronSchedules(config.hmilCronSchedule);
  for (const schedulePattern of schedules) {
    logger.info('Scheduling HMIL multi-account automation job', {
      cron: schedulePattern,
      mode: primaryAccount.defaultMode,
      accounts: selectedAccounts().map(account => ({
        id: account.id,
        userId: account.userId,
        dealerCodes: account.dealerCodes
      })),
      timezone: config.kiaCronTimezone
    });

    cron.schedule(
      schedulePattern,
      () => runHmilDmsJob(primaryAccount.defaultMode).catch(error => {
        logger.error('Scheduled HMIL multi-account job failed', error);
      }),
      { timezone: config.kiaCronTimezone }
    );
  }
}
