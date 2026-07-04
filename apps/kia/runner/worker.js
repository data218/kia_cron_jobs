import { createServiceWorker } from '../../../packages/automation-core/worker/service-worker.js';
import { runWorkerCli } from '../../../packages/automation-core/worker/worker-cli.js';
import { kiaServiceConfig } from '../config/service.js';
import { runKiaDailyPipeline } from './pipeline.js';

const worker = createServiceWorker(kiaServiceConfig, runKiaDailyPipeline);
await runWorkerCli({
  worker,
  runPipeline: runKiaDailyPipeline,
  serviceConfig: kiaServiceConfig
});
