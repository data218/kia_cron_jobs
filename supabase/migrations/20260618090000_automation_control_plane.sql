create extension if not exists pgcrypto;

create table if not exists public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  service text not null check (service in ('kia', 'platinum', 'hmil')),
  mode text not null default 'daily',
  scheduled_for timestamptz not null,
  idempotency_key text not null unique,
  source text not null check (source in ('edge', 'pm2-fallback', 'local-recovery', 'manual')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'success', 'completed_with_failures', 'failed', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  worker_id text,
  worker_version text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automation_jobs_claim_idx
  on public.automation_jobs (status, scheduled_for, created_at);

create table if not exists public.automation_report_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.automation_jobs(id) on delete cascade,
  service text not null,
  report_id text not null,
  report_name text not null,
  dealer_code text,
  account_id text,
  status text not null,
  row_count integer,
  duration_ms bigint,
  screenshot_path text,
  result jsonb,
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists automation_report_runs_job_idx
  on public.automation_report_runs (job_id, report_id);

create table if not exists public.automation_workers (
  worker_id text primary key,
  service text not null,
  version text,
  status text not null default 'idle',
  active_job_id uuid references public.automation_jobs(id) on delete set null,
  last_heartbeat_at timestamptz not null default now(),
  last_successful_poll_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.automation_service_state (
  service text primary key,
  enabled boolean not null default false,
  fallback_enabled boolean not null default true,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.automation_service_state (service, enabled)
values
  ('kia', true),
  ('platinum', false),
  ('hmil', false)
on conflict (service) do nothing;

create table if not exists public.automation_browser_lease (
  singleton boolean primary key default true check (singleton),
  job_id uuid references public.automation_jobs(id) on delete set null,
  service text,
  worker_id text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.automation_browser_lease (singleton)
values (true)
on conflict (singleton) do nothing;

create or replace function public.touch_automation_worker(
  p_service text,
  p_worker_id text,
  p_worker_version text default null,
  p_status text default 'idle'
)
returns public.automation_workers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_worker public.automation_workers;
begin
  insert into public.automation_workers (
    worker_id, service, version, status, last_heartbeat_at,
    last_successful_poll_at, updated_at
  )
  values (
    p_worker_id, p_service, p_worker_version, p_status, now(), now(), now()
  )
  on conflict (worker_id) do update
  set
    service = excluded.service,
    version = excluded.version,
    status = case
      when public.automation_workers.active_job_id is null then excluded.status
      else public.automation_workers.status
    end,
    last_heartbeat_at = excluded.last_heartbeat_at,
    last_successful_poll_at = excluded.last_successful_poll_at,
    updated_at = now()
  returning * into v_worker;

  return v_worker;
end;
$$;

create or replace function public.enqueue_automation_job(
  p_service text,
  p_mode text,
  p_scheduled_for timestamptz,
  p_source text,
  p_idempotency_key text
)
returns public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.automation_jobs;
begin
  insert into public.automation_jobs (
    service, mode, scheduled_for, source, idempotency_key
  )
  values (
    p_service, coalesce(p_mode, 'daily'), p_scheduled_for,
    coalesce(p_source, 'edge'), p_idempotency_key
  )
  on conflict (idempotency_key) do update
    set updated_at = now()
  returning * into v_job;

  return v_job;
end;
$$;

create or replace function public.claim_automation_job(
  p_service text,
  p_worker_id text,
  p_lease_seconds integer default 180,
  p_worker_version text default null
)
returns setof public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate public.automation_jobs;
  v_lease public.automation_browser_lease;
  v_enabled boolean;
begin
  select enabled into v_enabled
  from public.automation_service_state
  where service = p_service;
  if coalesce(v_enabled, false) is false then
    return;
  end if;

  update public.automation_jobs
  set
    status = case when attempts >= max_attempts then 'failed' else 'queued' end,
    worker_id = null,
    lease_expires_at = null,
    heartbeat_at = null,
    completed_at = case when attempts >= max_attempts then now() else completed_at end,
    error = case
      when attempts >= max_attempts
      then jsonb_build_object('message', 'Worker lease expired after maximum attempts')
      else error
    end,
    updated_at = now()
  where status = 'running'
    and lease_expires_at < now();

  select * into v_lease
  from public.automation_browser_lease
  where singleton = true
  for update;

  if v_lease.lease_expires_at is not null and v_lease.lease_expires_at > now() then
    return;
  end if;

  select * into v_candidate
  from public.automation_jobs
  where status = 'queued'
    and scheduled_for <= now()
  order by scheduled_for, created_at
  for update skip locked
  limit 1;

  if v_candidate.id is null or v_candidate.service <> p_service then
    return;
  end if;

  update public.automation_jobs
  set
    status = 'running',
    attempts = attempts + 1,
    worker_id = p_worker_id,
    worker_version = p_worker_version,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    heartbeat_at = now(),
    started_at = coalesce(started_at, now()),
    updated_at = now()
  where id = v_candidate.id
  returning * into v_candidate;

  update public.automation_browser_lease
  set
    job_id = v_candidate.id,
    service = p_service,
    worker_id = p_worker_id,
    lease_expires_at = v_candidate.lease_expires_at,
    heartbeat_at = now(),
    updated_at = now()
  where singleton = true;

  insert into public.automation_workers (
    worker_id, service, version, status, active_job_id,
    last_heartbeat_at, last_successful_poll_at, updated_at
  )
  values (
    p_worker_id, p_service, p_worker_version, 'running', v_candidate.id,
    now(), now(), now()
  )
  on conflict (worker_id) do update
  set
    service = excluded.service,
    version = excluded.version,
    status = excluded.status,
    active_job_id = excluded.active_job_id,
    last_heartbeat_at = excluded.last_heartbeat_at,
    last_successful_poll_at = excluded.last_successful_poll_at,
    updated_at = now();

  return next v_candidate;
end;
$$;

create or replace function public.heartbeat_automation_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 180,
  p_worker_version text default null
)
returns public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.automation_jobs;
begin
  update public.automation_jobs
  set
    heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    worker_version = coalesce(p_worker_version, worker_version),
    updated_at = now()
  where id = p_job_id
    and worker_id = p_worker_id
    and status = 'running'
  returning * into v_job;

  if v_job.id is null then
    raise exception 'Automation lease is no longer owned by worker';
  end if;

  update public.automation_browser_lease
  set
    lease_expires_at = v_job.lease_expires_at,
    heartbeat_at = now(),
    updated_at = now()
  where singleton = true
    and job_id = p_job_id
    and worker_id = p_worker_id;

  update public.automation_workers
  set
    version = coalesce(p_worker_version, version),
    status = 'running',
    active_job_id = p_job_id,
    last_heartbeat_at = now(),
    updated_at = now()
  where worker_id = p_worker_id;

  return v_job;
end;
$$;

create or replace function public.finish_automation_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_result jsonb default null,
  p_error jsonb default null
)
returns public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.automation_jobs;
begin
  update public.automation_jobs
  set
    status = p_status,
    result = p_result,
    error = p_error,
    completed_at = now(),
    lease_expires_at = null,
    heartbeat_at = now(),
    updated_at = now()
  where id = p_job_id
    and worker_id = p_worker_id
    and status = 'running'
  returning * into v_job;

  if v_job.id is null then
    raise exception 'Automation job is no longer owned by worker';
  end if;

  update public.automation_browser_lease
  set
    job_id = null,
    service = null,
    worker_id = null,
    lease_expires_at = null,
    heartbeat_at = null,
    updated_at = now()
  where singleton = true and job_id = p_job_id;

  update public.automation_workers
  set
    status = 'idle',
    active_job_id = null,
    last_heartbeat_at = now(),
    updated_at = now()
  where worker_id = p_worker_id;

  update public.automation_service_state
  set
    last_success_at = case
      when p_status in ('success', 'completed_with_failures') then now()
      else last_success_at
    end,
    consecutive_failures = case
      when p_status = 'success' then 0
      else consecutive_failures + 1
    end,
    updated_at = now()
  where service = v_job.service;

  return v_job;
end;
$$;

create or replace function public.record_recovered_automation_job(
  p_service text,
  p_idempotency_key text,
  p_status text,
  p_result jsonb default null,
  p_error jsonb default null,
  p_completed_at timestamptz default now()
)
returns public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.automation_jobs;
begin
  insert into public.automation_jobs (
    service, mode, scheduled_for, idempotency_key, source, status,
    attempts, started_at, completed_at, result, error
  )
  values (
    p_service, 'daily', p_completed_at, p_idempotency_key, 'local-recovery',
    p_status, 1, p_completed_at, p_completed_at, p_result, p_error
  )
  on conflict (idempotency_key) do update
  set
    status = excluded.status,
    completed_at = excluded.completed_at,
    result = excluded.result,
    error = excluded.error,
    updated_at = now()
  where public.automation_jobs.status not in ('success', 'completed_with_failures')
  returning * into v_job;

  if v_job.id is null then
    select * into v_job
    from public.automation_jobs
    where idempotency_key = p_idempotency_key;
  end if;

  return v_job;
end;
$$;

revoke all on function public.enqueue_automation_job(text, text, timestamptz, text, text) from public;
revoke all on function public.touch_automation_worker(text, text, text, text) from public;
revoke all on function public.claim_automation_job(text, text, integer, text) from public;
revoke all on function public.heartbeat_automation_job(uuid, text, integer, text) from public;
revoke all on function public.finish_automation_job(uuid, text, text, jsonb, jsonb) from public;
revoke all on function public.record_recovered_automation_job(text, text, text, jsonb, jsonb, timestamptz) from public;

grant execute on function public.enqueue_automation_job(text, text, timestamptz, text, text) to service_role;
grant execute on function public.touch_automation_worker(text, text, text, text) to service_role;
grant execute on function public.claim_automation_job(text, text, integer, text) to service_role;
grant execute on function public.heartbeat_automation_job(uuid, text, integer, text) to service_role;
grant execute on function public.finish_automation_job(uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.record_recovered_automation_job(text, text, text, jsonb, jsonb, timestamptz) to service_role;
