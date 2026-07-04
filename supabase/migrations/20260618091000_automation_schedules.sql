create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

create or replace function public.invoke_automation_enqueue(p_service text)
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
      'mode', 'daily',
      'scheduled_for', now()
    )
  ) into v_request_id;

  return v_request_id;
end;
$$;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname in (
      'enqueue-kia-daily',
      'enqueue-platinum-daily',
      'enqueue-hmil-daily'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'enqueue-kia-daily',
  '30 3 * * *',
  $$select public.invoke_automation_enqueue('kia');$$
);

select cron.schedule(
  'enqueue-platinum-daily',
  '45 3 * * *',
  $$select public.invoke_automation_enqueue('platinum');$$
);

select cron.schedule(
  'enqueue-hmil-daily',
  '50 3 * * *',
  $$select public.invoke_automation_enqueue('hmil');$$
);
