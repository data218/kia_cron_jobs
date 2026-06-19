import { createServiceWorker } from '../../../packages/automation-core/worker/service-worker.js';
import { runWorkerCli } from '../../../packages/automation-core/worker/worker-cli.js';
import { hmilServiceConfig } from '../config/service.js';
import { runHmilDailyPipeline } from './pipeline.js';

const worker = createServiceWorker(hmilServiceConfig, runHmilDailyPipeline);
await runWorkerCli({
  worker,
  runPipeline: runHmilDailyPipeline,
  serviceConfig: hmilServiceConfig
});
