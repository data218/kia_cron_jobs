import { withPostgresClient } from '../src/supabase/postgres.js';

await withPostgresClient(async client => {
  console.log('--- STARTING HYUNDAI OPERATION-WISE DATABASE MIGRATION ---');

  console.log('1. Truncating hyundai_operation_wise_analysis_report...');
  await client.query('TRUNCATE TABLE public.hyundai_operation_wise_analysis_report CASCADE');

  console.log('2. Dropping old row_hash constraint...');
  await client.query(`
    ALTER TABLE public.hyundai_operation_wise_analysis_report
    DROP CONSTRAINT IF EXISTS hyundai_operation_wise_analysis_report_row_hash_key CASCADE
  `);

  console.log('3. Dropping old row_hash unique index...');
  await client.query(`
    DROP INDEX IF EXISTS public.idx_hyundai_operation_wise_analysis_report_row_hash CASCADE
  `);

  console.log('4. Adding natural composite unique constraint...');
  await client.query(`
    ALTER TABLE public.hyundai_operation_wise_analysis_report
    ADD CONSTRAINT hyundai_op_wise_natural_key
    UNIQUE (source_dealer_code, report_type, report_period_start, report_period_end, op_part_code)
  `);

  console.log('5. Verifying new constraints on table...');
  const res = await client.query(`
    SELECT conname, pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'public.hyundai_operation_wise_analysis_report'::regclass
  `);
  console.table(res.rows);

  console.log('--- MIGRATION COMPLETED SUCCESSFULLY ---');
});
