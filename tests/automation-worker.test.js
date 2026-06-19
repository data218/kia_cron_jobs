import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServiceWorker } from '../packages/automation-core/worker/service-worker.js';

async function createTestConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-worker-'));
  return {
    service: 'kia',
    mode: 'daily',
    rolloutEnabled: true,
    workerId: 'test-worker',
    version: 'test',
    leaseSeconds: 180,
    heartbeatIntervalMs: 60000,
    pollIntervalMs: 60000,
    triggerCron: '0 9 * * *',
    fallbackCron: '10 9 * * *',
    timezone: 'Asia/Kolkata',
    runtimeDir: path.join(root, 'runtime'),
    ledgerPath: path.join(root, 'runtime', 'recovery-ledger.json'),
    healthPath: path.join(root, 'runtime', 'health.json'),
    globalLockDir: path.join(root, 'global.lock'),
    root
  };
}

test('claimed jobs finish with report-level results', async t => {
  const config = await createTestConfig();
  t.after(() => fs.rm(config.root, { recursive: true, force: true }));
  const calls = [];
  const queue = {
    heartbeat: async () => {},
    recordReportRun: async (jobId, report) => calls.push(['report', jobId, report]),
    finish: async value => calls.push(['finish', value])
  };
  const worker = createServiceWorker(config, async () => ({
    status: 'completed_with_failures',
    reports: [
      { reportId: 'one', report: 'One', status: 'success', rowCount: 7 },
      { reportId: 'two', report: 'Two', status: 'failed', error: { message: 'boom' } }
    ]
  }), { queue });

  await worker.executeClaimedJob({
    id: 'job-1',
    idempotency_key: 'kia:2026-06-18:daily',
    source: 'edge'
  });

  assert.equal(calls.filter(([type]) => type === 'report').length, 2);
  assert.equal(calls.find(([type]) => type === 'finish')[1].status, 'completed_with_failures');
  const health = JSON.parse(await fs.readFile(config.healthPath, 'utf8'));
  assert.equal(health.status, 'completed_with_failures');
});

test('fallback runs locally and records recovery when Supabase is unavailable', async t => {
  const config = await createTestConfig();
  t.after(() => fs.rm(config.root, { recursive: true, force: true }));
  const queue = {
    serviceState: async () => {
      throw new Error('database offline');
    }
  };
  let runs = 0;
  const worker = createServiceWorker(config, async () => {
    runs += 1;
    return { status: 'success', reports: [] };
  }, { queue });

  await worker.runFallback();

  assert.equal(runs, 1);
  const ledger = JSON.parse(await fs.readFile(config.ledgerPath, 'utf8'));
  const entries = Object.values(ledger.runs);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'success');
  assert.equal(entries[0].synced, false);
  const health = JSON.parse(await fs.readFile(config.healthPath, 'utf8'));
  assert.equal(health.status, 'success');
  assert.equal(health.source, 'local-recovery');
});
