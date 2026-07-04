# Independent automation workers

The production target is three isolated application workers:

- `kia-worker`: enabled first, scheduled for 09:00 IST.
- `platinum-worker`: staged disabled, scheduled for 09:15 IST.
- `hmil-worker`: staged disabled, scheduled for 09:20 IST. It runs regular HMIL and then Warranty sequentially.

Supabase Cron invokes the `enqueue-automation-job` Edge Function. The function only creates an idempotent queue row. Playwright always runs on the PM2 machine.

## Required deployment order

1. Apply `supabase/migrations/20260618090000_automation_control_plane.sql`.
2. Add Vault secrets `automation_project_url` and `automation_enqueue_secret`.
3. Deploy `supabase/functions/enqueue-automation-job` with `AUTOMATION_ENQUEUE_SECRET`.
4. Apply `supabase/migrations/20260618091000_automation_schedules.sql`.
5. Ensure the PM2 host has `DATABASE_URL` and the existing portal credentials.
6. Run `npm test` and `npm run check`.
7. Start or reload `ecosystem.config.cjs`.

The database starts with only KIA enabled. Platinum and HMIL continue using their legacy PM2 schedulers until each service has passed its rollout checks. Their new workers may remain online with their worker flags set to `false`.

## Rollout controls

There are two gates per service:

- PM2 environment flag: `KIA_WORKER_ENABLED`, `PLATINUM_WORKER_ENABLED`, or `HMIL_WORKER_ENABLED`.
- Database flag: `automation_service_state.enabled`.

Both must be enabled before a worker claims queue jobs. When migrating Platinum or HMIL, enable the new worker and database flag, then remove the matching legacy scheduler from PM2 in the same deployment to prevent duplicate runs.

## Manual commands

```text
npm run worker:kia:once
npm run worker:platinum:once
npm run worker:hmil:once
```

Manual `--once` runs bypass Supabase queueing but still use the existing portal/session/report implementations.

## Recovery behavior

At 09:10, 09:25, and 09:30 IST the corresponding PM2 worker checks the daily idempotency key. If Supabase is reachable, it enqueues the missing job. If Supabase is unavailable, it runs locally under the global browser lock and records the result in the service recovery ledger for later reconciliation.

Runtime state is service-owned under `apps/<service>/runtime/`. The global filesystem lock and database browser lease prevent two portal automations from running at the same time.
