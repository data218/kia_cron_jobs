-- Update invoke_automation_enqueue to accept p_mode parameter
create or replace function public.invoke_automation_enqueue(
  p_service text,
  p_mode text default 'daily'
)
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_project_url text;
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_project_url
  from vault.decrypted_secrets
  where name = 'automation_project_url';

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'automation_enqueue_secret';

  if v_project_url is null or v_secret is null then
    raise exception 'Missing automation_project_url or automation_enqueue_secret Vault secret';
  end if;

  select net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/enqueue-automation-job',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-automation-secret', v_secret
    ),
    body := jsonb_build_object(
      'service', p_service,
      'mode', p_mode,
      'scheduled_for', now()
    )
  ) into v_request_id;

  return v_request_id;
end;
$$;

-- Unschedule existing RSA cron jobs to allow idempotency
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'enqueue-kia-rsa-10am',
      'enqueue-kia-rsa-6pm'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

-- 10:00 AM IST = 04:30 AM UTC
select cron.schedule(
  'enqueue-kia-rsa-10am',
  '30 4 * * *',
  $$select public.invoke_automation_enqueue('kia', 'rsa-report');$$
);

-- 06:00 PM IST = 12:30 PM UTC
select cron.schedule(
  'enqueue-kia-rsa-6pm',
  '30 12 * * *',
  $$select public.invoke_automation_enqueue('kia', 'rsa-report');$$
);
