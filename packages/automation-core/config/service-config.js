import os from 'node:os';
import path from 'node:path';
import { config } from '../../../src/config.js';

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

export function createServiceConfig({
  service,
  displayName,
  triggerCron,
  fallbackCron,
  rolloutEnabled
}) {
  const prefix = service.toUpperCase().replaceAll('-', '_');
  const runtimeDir = path.join(config.rootDir, 'apps', service, 'runtime');

  return {
    service,
    displayName,
    mode: 'daily',
    triggerCron,
    fallbackCron,
    timezone: 'Asia/Kolkata',
    rolloutEnabled: envBool(`${prefix}_WORKER_ENABLED`, rolloutEnabled),
    pollIntervalMs: envInt('AUTOMATION_QUEUE_POLL_INTERVAL_MS', 15000),
    heartbeatIntervalMs: envInt('AUTOMATION_HEARTBEAT_INTERVAL_MS', 30000),
    leaseSeconds: envInt('AUTOMATION_JOB_LEASE_SECONDS', 180),
    workerId: process.env.AUTOMATION_WORKER_ID ||
      `${os.hostname()}:${service}:${process.pid}`,
    version: process.env.APP_VERSION ||
      process.env.GIT_COMMIT ||
      'development',
    runtimeDir,
    ledgerPath: path.join(runtimeDir, 'recovery-ledger.json'),
    healthPath: path.join(runtimeDir, 'worker-health.json'),
    globalLockDir: path.join(config.tempDir, 'automation-global-browser.lock')
  };
}

export function dailyIdempotencyKey(service, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${service}:${values.year}-${values.month}-${values.day}:daily`;
}
