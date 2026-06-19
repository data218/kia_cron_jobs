import fs from 'node:fs/promises';
import cron from 'node-cron';
import { logger } from '../../../src/utils/logger.js';
import { withDirectoryLock } from '../../../src/utils/file-lock.js';
import { dailyIdempotencyKey } from '../config/service-config.js';
import { PostgresJobQueue } from '../queue/postgres-job-queue.js';
import {
  hasLocalRun,
  listUnsyncedLocalRuns,
  markLocalRunSynced,
  recordLocalRun
} from './local-ledger.js';

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

function normalizeReports(service, result) {
  const candidates = result?.reports ?? result?.results ?? [];
  return candidates.map(item => ({
    service,
    reportId: item.reportId ?? item.id ?? item.name ?? 'unknown',
    reportName: item.report ?? item.name ?? item.reportId ?? 'Unknown report',
    dealerCode: item.dealerCode ?? null,
    accountId: item.accountId ?? item.sourceLoginId ?? null,
    status: item.status ?? (item.failed ? 'failed' : 'success'),
    rowCount: item.rowCount ?? item.dbResult?.rowCount ?? null,
    durationMs: item.durationMs ?? null,
    screenshotPath: item.screenshotPath ?? null,
    result: item,
    error: item.error ?? null,
    startedAt: item.startedAt ?? null,
    completedAt: item.completedAt ?? new Date().toISOString()
  }));
}

async function writeHealth(serviceConfig, status) {
  await fs.mkdir(serviceConfig.runtimeDir, { recursive: true });
  await fs.writeFile(serviceConfig.healthPath, JSON.stringify({
    service: serviceConfig.service,
    workerId: serviceConfig.workerId,
    version: serviceConfig.version,
    updatedAt: new Date().toISOString(),
    ...status
  }, null, 2));
}

export function createServiceWorker(serviceConfig, runPipeline, {
  queue = new PostgresJobQueue()
} = {}) {
  let stopped = false;
  let busy = false;
  let pollTimer;

  async function runWithGlobalLock(job) {
    return withDirectoryLock(
      serviceConfig.globalLockDir,
      () => runPipeline(job),
      {
        label: `automation-global-browser-${serviceConfig.service}`,
        timeoutMs: 21600000,
        staleMs: 21600000,
        pollMs: 1000
      }
    );
  }

  async function syncRecoveryLedger() {
    const pending = await listUnsyncedLocalRuns(serviceConfig.ledgerPath);
    for (const item of pending) {
      try {
        await queue.reconcileLocalRun({
          service: serviceConfig.service,
          idempotencyKey: item.idempotencyKey,
          status: item.status,
          result: item.result,
          error: item.error,
          completedAt: item.completedAt ?? item.updatedAt
        });
        await markLocalRunSynced(serviceConfig.ledgerPath, item.idempotencyKey);
      } catch (error) {
        logger.warn('Unable to synchronize local recovery run', {
          service: serviceConfig.service,
          idempotencyKey: item.idempotencyKey,
          error: error.message
        });
      }
    }
  }

  async function executeClaimedJob(job) {
    busy = true;
    const startedAt = Date.now();
    let heartbeatTimer;
    await writeHealth(serviceConfig, {
      status: 'running',
      jobId: job.id,
      idempotencyKey: job.idempotency_key
    });

    try {
      heartbeatTimer = setInterval(() => {
        queue.heartbeat({
          jobId: job.id,
          workerId: serviceConfig.workerId,
          leaseSeconds: serviceConfig.leaseSeconds,
          version: serviceConfig.version
        }).catch(error => logger.warn('Automation heartbeat failed', {
          service: serviceConfig.service,
          jobId: job.id,
          error: error.message
        }));
      }, serviceConfig.heartbeatIntervalMs);

      const result = await runWithGlobalLock(job);
      for (const report of normalizeReports(serviceConfig.service, result)) {
        await queue.recordReportRun(job.id, report).catch(error => {
          logger.warn('Unable to record automation report result', {
            service: serviceConfig.service,
            jobId: job.id,
            reportId: report.reportId,
            error: error.message
          });
        });
      }
      const status = result?.status === 'completed_with_failures'
        ? 'completed_with_failures'
        : 'success';
      await queue.finish({
        jobId: job.id,
        workerId: serviceConfig.workerId,
        status,
        result
      });
      await recordLocalRun(serviceConfig.ledgerPath, job.idempotency_key, {
        status,
        source: job.source,
        jobId: job.id,
        result,
        completedAt: new Date().toISOString(),
        synced: true
      });
      await writeHealth(serviceConfig, {
        status,
        jobId: job.id,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const serialized = serializeError(error);
      await queue.finish({
        jobId: job.id,
        workerId: serviceConfig.workerId,
        status: 'failed',
        error: serialized
      }).catch(() => {});
      await writeHealth(serviceConfig, {
        status: 'failed',
        jobId: job.id,
        durationMs: Date.now() - startedAt,
        error: serialized
      });
      logger.error('Automation job failed', {
        service: serviceConfig.service,
        jobId: job.id,
        err: serialized
      });
    } finally {
      clearInterval(heartbeatTimer);
      busy = false;
    }
  }

  async function pollOnce() {
    if (stopped || busy || !serviceConfig.rolloutEnabled) return null;
    try {
      await syncRecoveryLedger();
      await queue.registerWorker({
        service: serviceConfig.service,
        workerId: serviceConfig.workerId,
        version: serviceConfig.version,
        status: 'idle'
      });
      const state = await queue.serviceState(serviceConfig.service);
      if (state && !state.enabled) return null;
      const job = await queue.claim({
        service: serviceConfig.service,
        workerId: serviceConfig.workerId,
        leaseSeconds: serviceConfig.leaseSeconds,
        version: serviceConfig.version
      });
      if (job) {
        await executeClaimedJob(job);
      }
      return job;
    } catch (error) {
      logger.warn('Automation queue poll failed', {
        service: serviceConfig.service,
        error: error.message
      });
      return null;
    }
  }

  async function runFallback() {
    if (stopped || busy || !serviceConfig.rolloutEnabled) return;
    const idempotencyKey = dailyIdempotencyKey(serviceConfig.service);
    if (await hasLocalRun(serviceConfig.ledgerPath, idempotencyKey)) return;

    try {
      const state = await queue.serviceState(serviceConfig.service);
      if (state && !state.enabled) return;
      await queue.enqueue({
        service: serviceConfig.service,
        scheduledFor: new Date().toISOString(),
        mode: serviceConfig.mode,
        source: 'pm2-fallback',
        idempotencyKey
      });
      await pollOnce();
      return;
    } catch (error) {
      logger.warn('Supabase unavailable during fallback; running from local recovery ledger', {
        service: serviceConfig.service,
        idempotencyKey,
        error: error.message
      });
    }

    busy = true;
    const startedAt = Date.now();
    await writeHealth(serviceConfig, {
      status: 'running',
      jobId: null,
      idempotencyKey,
      source: 'local-recovery'
    });
    try {
      const result = await runWithGlobalLock({
        id: null,
        service: serviceConfig.service,
        mode: serviceConfig.mode,
        source: 'local-recovery',
        idempotency_key: idempotencyKey
      });
      const status = result?.status === 'completed_with_failures'
        ? 'completed_with_failures'
        : 'success';
      const completedAt = new Date().toISOString();
      await recordLocalRun(serviceConfig.ledgerPath, idempotencyKey, {
        status,
        source: 'local-recovery',
        result,
        completedAt
      });
      await writeHealth(serviceConfig, {
        status,
        jobId: null,
        idempotencyKey,
        source: 'local-recovery',
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const serialized = serializeError(error);
      const completedAt = new Date().toISOString();
      await recordLocalRun(serviceConfig.ledgerPath, idempotencyKey, {
        status: 'failed',
        source: 'local-recovery',
        error: serialized,
        completedAt
      });
      await writeHealth(serviceConfig, {
        status: 'failed',
        jobId: null,
        idempotencyKey,
        source: 'local-recovery',
        durationMs: Date.now() - startedAt,
        error: serialized
      });
    } finally {
      busy = false;
    }
  }

  async function start() {
    await writeHealth(serviceConfig, {
      status: serviceConfig.rolloutEnabled ? 'idle' : 'disabled',
      triggerCron: serviceConfig.triggerCron,
      fallbackCron: serviceConfig.fallbackCron
    });
    cron.schedule(serviceConfig.fallbackCron, runFallback, {
      timezone: serviceConfig.timezone
    });
    pollTimer = setInterval(pollOnce, serviceConfig.pollIntervalMs);
    await pollOnce();
  }

  async function stop() {
    stopped = true;
    clearInterval(pollTimer);
    await writeHealth(serviceConfig, { status: 'stopped' });
  }

  return {
    start,
    stop,
    pollOnce,
    runFallback,
    executeClaimedJob,
    isBusy: () => busy
  };
}
