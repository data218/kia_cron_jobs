import { runKiaDmsJob } from '../src/cron/scheduler.js';
import { logger } from '../src/utils/logger.js';

runKiaDmsJob('demo-car-list').catch(error => {
  logger.error('Demo Car List one-off run failed', {
    err: {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  });
  process.exitCode = 1;
});
