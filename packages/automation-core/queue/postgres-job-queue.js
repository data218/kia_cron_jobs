import { withPostgresClient } from '../../../src/supabase/postgres.js';

function firstRow(result) {
  return result.rows[0] ?? null;
}

export class PostgresJobQueue {
  async registerWorker({ service, workerId, version, status = 'idle' }) {
    return withPostgresClient(async client => firstRow(await client.query(
      'select * from public.touch_automation_worker($1, $2, $3, $4)',
      [service, workerId, version, status]
    )));
  }

  async enqueue({
    service,
    scheduledFor,
    mode = 'daily',
    source = 'edge',
    idempotencyKey
  }) {
    return withPostgresClient(async client => firstRow(await client.query(
      'select * from public.enqueue_automation_job($1, $2, $3, $4, $5)',
      [service, mode, scheduledFor, source, idempotencyKey]
    )));
  }

  async claim({ service, workerId, leaseSeconds, version }) {
    return withPostgresClient(async client => firstRow(await client.query(
      'select * from public.claim_automation_job($1, $2, $3, $4)',
      [service, workerId, leaseSeconds, version]
    )));
  }

  async heartbeat({ jobId, workerId, leaseSeconds, version }) {
    return withPostgresClient(async client => firstRow(await client.query(
      'select * from public.heartbeat_automation_job($1, $2, $3, $4)',
      [jobId, workerId, leaseSeconds, version]
    )));
  }

  async finish({ jobId, workerId, status, result = null, error = null }) {
    return withPostgresClient(async client => firstRow(await client.query(
      'select * from public.finish_automation_job($1, $2, $3, $4::jsonb, $5::jsonb)',
      [
        jobId,
        workerId,
        status,
        result == null ? null : JSON.stringify(result),
        error == null ? null : JSON.stringify(error)
      ]
    )));
  }

  async recordReportRun(jobId, report) {
    return withPostgresClient(async client => firstRow(await client.query(
      `
        insert into public.automation_report_runs (
          job_id, service, report_id, report_name, dealer_code, account_id,
          status, row_count, duration_ms, screenshot_path, result, error,
          started_at, completed_at
        )
        values (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11::jsonb, $12::jsonb,
          $13, $14
        )
        returning *
      `,
      [
        jobId,
        report.service,
        report.reportId,
        report.reportName,
        report.dealerCode,
        report.accountId,
        report.status,
        report.rowCount,
        report.durationMs,
        report.screenshotPath,
        JSON.stringify(report.result ?? {}),
        report.error == null ? null : JSON.stringify(report.error),
        report.startedAt,
        report.completedAt
      ]
    )));
  }

  async serviceState(service) {
    return withPostgresClient(async client => firstRow(await client.query(
      'select * from public.automation_service_state where service = $1',
      [service]
    )));
  }

  async reconcileLocalRun({
    service,
    idempotencyKey,
    status,
    result = null,
    error = null,
    completedAt
  }) {
    return withPostgresClient(async client => firstRow(await client.query(
      'select * from public.record_recovered_automation_job($1, $2, $3, $4::jsonb, $5::jsonb, $6)',
      [
        service,
        idempotencyKey,
        status,
        result == null ? null : JSON.stringify(result),
        error == null ? null : JSON.stringify(error),
        completedAt
      ]
    )));
  }
}
