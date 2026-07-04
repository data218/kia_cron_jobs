import { logger } from '../../../src/utils/logger.js';

export async function runWorkerCli({ worker, runPipeline, serviceConfig }) {
  if (process.argv.includes('--once')) {
    const result = await runPipeline({
      service: serviceConfig.service,
      mode: serviceConfig.mode,
      source: 'manual',
      idempotency_key: `manual:${serviceConfig.service}:${Date.now()}`
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  await worker.start();
  logger.info('Independent automation worker started', {
    service: serviceConfig.service,
    workerId: serviceConfig.workerId,
    version: serviceConfig.version,
    enabled: serviceConfig.rolloutEnabled,
    pollIntervalMs: serviceConfig.pollIntervalMs,
    fallbackCron: serviceConfig.fallbackCron,
    timezone: serviceConfig.timezone
  });

  const stop = async signal => {
    logger.info('Stopping independent automation worker', {
      service: serviceConfig.service,
      signal
    });
    await worker.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}
