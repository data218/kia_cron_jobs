import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { runKiaDmsJob } from './scheduler.js';
import { logger } from '../utils/logger.js';
import { writeHealthStatus } from '../utils/health.js';

function isMainModule() {
  const argvPath = process.env.pm_exec_path || process.argv[1];
  if (!argvPath) return false;
  return path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(argvPath).toLowerCase();
}

const shouldRunFromCli = isMainModule();

if (shouldRunFromCli && process.argv.includes('--once')) {
  logger.info('Running standalone RSA Report job once from CLI');
  await runKiaDmsJob('rsa-report');
} else if (shouldRunFromCli) {
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

  const cronOptions = { timezone: config.kiaCronTimezone };
  const cronSchedule = config.rsaReportCronSchedule;

  const schedules = parseCronSchedules(cronSchedule);
  for (const schedulePattern of schedules) {
    logger.info('Scheduling standalone PM2 RSA Report automation job', {
      cron: schedulePattern,
      mode: 'rsa-report',
      timezone: config.kiaCronTimezone
    });

    cron.schedule(schedulePattern, () => {
      logger.info('Triggering scheduled standalone RSA Report job', { cron: schedulePattern });
      runKiaDmsJob('rsa-report').catch(err => {
        logger.error('Scheduled standalone RSA Report job failed', err);
      });
    }, cronOptions);
  }

  await writeHealthStatus({
    status: 'idle',
    mode: 'rsa-report-scheduler',
    startedAt: new Date().toISOString()
  });
}
