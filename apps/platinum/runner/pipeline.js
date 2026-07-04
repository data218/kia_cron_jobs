import path from 'node:path';
import { config } from '../../../src/config.js';
import { runAmPlatinumDmsJob } from '../../../src/cron/am-platinum-scheduler.js';
import {
  assertSuccessfulHealth,
  readHealthFile
} from '../../../packages/automation-core/health/read-health.js';

export async function runPlatinumDailyPipeline() {
  await runAmPlatinumDmsJob('am-platinum-regular');
  const health = await readHealthFile(path.join(config.logsDir, 'am-platinum-health.json'));
  assertSuccessfulHealth(health, 'AM Platinum daily pipeline');
  return {
    status: health.status,
    reports: health.reports ?? [],
    startedAt: health.startedAt,
    completedAt: health.completedAt,
    durationMs: health.durationMs
  };
}
