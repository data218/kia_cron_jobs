process.env.DRY_RUN_REPORTS = 'true';
process.env.DRY_RUN_REPORT_DELAY_MS ??= '300';
process.env.REPORTS_TO_RUN ??= 'all';
process.env.TEST_SINGLE_REPORT ??= 'false';

const { runKiaDmsJob } = await import('./scheduler.js');
const { logger } = await import('../utils/logger.js');
const { sleep } = await import('../utils/sleep.js');

logger.info('Sequential scheduler dry-run test started');

logger.info('Starting regular lane dry-run');
await runKiaDmsJob('regular');

logger.info('Starting Open RO Yearly lane dry-run after regular lane completed');
await runKiaDmsJob('open-ro-yearly');

logger.info('Testing overlap lock: starting regular lane and immediately requesting Open RO lane');
const runningJob = runKiaDmsJob('regular');
await sleep(50);
await runKiaDmsJob('open-ro-yearly');
await runningJob;

logger.info('Sequential scheduler dry-run test finished');
