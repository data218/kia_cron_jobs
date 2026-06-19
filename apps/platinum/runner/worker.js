import { createServiceWorker } from '../../../packages/automation-core/worker/service-worker.js';
import { runWorkerCli } from '../../../packages/automation-core/worker/worker-cli.js';
import { platinumServiceConfig } from '../config/service.js';
import { runPlatinumDailyPipeline } from './pipeline.js';

const worker = createServiceWorker(platinumServiceConfig, runPlatinumDailyPipeline);
await runWorkerCli({
  worker,
  runPipeline: runPlatinumDailyPipeline,
  serviceConfig: platinumServiceConfig
});
