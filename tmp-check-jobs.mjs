import { withPostgresClient } from './src/supabase/postgres.js';

await withPostgresClient(async client => {
  console.log('=== PG_CRON JOBS ===');
  const cronJobs = await client.query('select jobid, schedule, command, nodename, nodeport, database, username, active, jobname from cron.job');
  console.table(cronJobs.rows);
});
