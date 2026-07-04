import { withPostgresClient } from 'file:///c:/Users/sahil/Downloads/kia_cron_jobs/src/supabase/postgres.js';

console.log('Connecting to Supabase Database...');
try {
  await withPostgresClient(async client => {
    console.log('Truncating table public.am_platinum_operation_wise_analysis_report...');
    await client.query('TRUNCATE TABLE public.am_platinum_operation_wise_analysis_report CASCADE');
    console.log('✅ Table successfully truncated!');
  });
} catch (error) {
  console.error('❌ Failed to truncate table:', error.message);
  process.exit(1);
}
