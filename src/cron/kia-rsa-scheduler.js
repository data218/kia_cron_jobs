import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { runKiaDmsJob } from './scheduler.js';
import { logger } from '../utils/logger.js';
import { writeHealthStatus } from '../utils/health.js';

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
}

const shouldRunFromCli = isMainModule() || process.argv.includes('--scheduler');

if (shouldRunFromCli && process.argv.includes('--once')) {
  logger.info('Running standalone RSA Report job once from CLI');
  await runKiaDmsJob('rsa-report');
} else if (shouldRunFromCli) {
  const cronOptions = { timezone: config.kiaCronTimezone };
  const cronSchedule = config.rsaReportCronSchedule;

  logger.info('Scheduling standalone PM2 RSA Report automation job', {
    cron: cronSchedule,
    mode: 'rsa-report',
    timezone: config.kiaCronTimezone
  });

  cron.schedule(cronSchedule, () => {
    logger.info('Triggering scheduled standalone RSA Report job');
    runKiaDmsJob('rsa-report').catch(err => {
      logger.error('Scheduled standalone RSA Report job failed', err);
    });
  }, cronOptions);

  await writeHealthStatus({
    status: 'idle',
    mode: 'rsa-report-scheduler',
    startedAt: new Date().toISOString()
  });
}
