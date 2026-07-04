import path from 'node:path';
import { config } from '../../../src/config.js';
import { runKiaDmsJob } from '../../../src/cron/scheduler.js';
import {
  assertSuccessfulHealth,
  readHealthFile
} from '../../../packages/automation-core/health/read-health.js';

export async function runKiaDailyPipeline(job) {
  const mode = job?.mode || 'configured';
  await runKiaDmsJob(mode);
  const health = await readHealthFile(path.join(config.logsDir, 'health.json'));
  assertSuccessfulHealth(health, 'KIA daily pipeline');
  return {
    status: health.status,
    reports: health.reports ?? [],
    startedAt: health.startedAt,
    completedAt: health.completedAt,
    durationMs: health.durationMs
  };
}
