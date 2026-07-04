import { runKiaDmsJob } from '../src/cron/scheduler.js';
import { logger } from '../src/utils/logger.js';

const modes = [
  'kia-booking-report-historical',
  'kia-sales-report-historical',
  'kia-enquiry-report-historical',
  'kia-accessories-counter-sales-report-historical',
  'kia-purchase-report-historical'
];

try {
  logger.info('Starting Kia monthly MIS historical run in a single login session', { modes });
  await runKiaDmsJob(modes);
  logger.info('Completed Kia monthly MIS historical run in a single login session', { modes });
} catch (error) {
  logger.error('Kia monthly MIS historical backfill failed', {
    err: {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  });
  process.exitCode = 1;
}
