import path from 'node:path';
import { createHmilWarrantyAccounts } from '../../../src/accounts/hmil-warranty-accounts.js';
import { config } from '../../../src/config.js';
import { runHmilDmsJob } from '../../../src/cron/hmil-scheduler.js';
import { runHmilWarrantyJob } from '../../../src/cron/hmil-warranty-scheduler.js';
import {
  assertSuccessfulHealth,
  readHealthFile
} from '../../../packages/automation-core/health/read-health.js';

export async function runHmilDailyPipeline() {
  const reports = [];
  let status = 'success';

  try {
    await runHmilDmsJob('hyundai-regular');
    const regularHealth = await readHealthFile(path.join(config.logsDir, 'hmil-health.json'));
    assertSuccessfulHealth(regularHealth, 'HMIL regular pipeline');
    reports.push(...(regularHealth.reports ?? []));
    if (regularHealth.status === 'completed_with_failures') {
      status = 'completed_with_failures';
    }
  } catch (error) {
    status = 'completed_with_failures';
    reports.push({
      status: 'failed',
      reportId: 'hmil-regular-pipeline',
      report: 'HMIL regular pipeline',
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    });
  }

  const accounts = createHmilWarrantyAccounts().map((account, index) => (
    index === 0
      ? { ...account, sessionStatePath: config.hmilSessionStatePath }
      : account
  ));
  const warrantyResults = await runHmilWarrantyJob('scheduled', {
    accounts,
    skipTableClear: true,
    resume: true
  });
  reports.push(...warrantyResults);
  if (warrantyResults.some(result => result.status === 'failed')) {
    status = 'completed_with_failures';
  }

  return {
    status,
    reports,
    completedAt: new Date().toISOString()
  };
}
