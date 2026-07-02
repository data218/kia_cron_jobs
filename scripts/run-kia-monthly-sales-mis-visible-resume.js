import { runKiaDmsJob } from '../src/cron/scheduler.js';
import { logger } from '../src/utils/logger.js';

const modes = [
  'kia-sales-report-historical',
  'kia-enquiry-report-historical',
  'kia-accessories-counter-sales-report-historical'
];

try {
  logger.info('Starting visible Kia monthly MIS historical resume in a single login session', { modes });
  await runKiaDmsJob(modes);
  logger.info('Completed visible Kia monthly MIS historical resume in a single login session', { modes });
} catch (error) {
  logger.error('Visible Kia monthly MIS historical resume failed', {
    err: {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  });
  process.exitCode = 1;
}
