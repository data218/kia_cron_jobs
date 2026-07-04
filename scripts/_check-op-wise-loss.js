import { withPostgresClient } from '../src/supabase/postgres.js';

await withPostgresClient(async client => {
  const total = await client.query('SELECT COUNT(*) as total FROM public.hyundai_operation_wise_analysis_report');
  console.log('Total rows:', total.rows[0].total);
  console.log();

  const coverage = await client.query(`
    SELECT 
      dealer_code,
      COUNT(*) as total_rows,
      COUNT(DISTINCT TO_CHAR(report_month::date, 'YYYY-MM')) as distinct_months,
      MIN(report_month::date) as earliest,
      MAX(report_month::date) as latest
    FROM public.hyundai_operation_wise_analysis_report
    GROUP BY dealer_code
    ORDER BY dealer_code
  `);
  console.log('Coverage per dealer:');
  console.log('-'.repeat(80));
  coverage.rows.forEach(r => {
    const months = parseInt(r.distinct_months);
    const years = (months / 12).toFixed(1);
    console.log(`  ${r.dealer_code}  |  ${r.total_rows} rows  |  ${r.distinct_months} months (~${years} yrs)  |  ${r.earliest?.toISOString().slice(0,10)} to ${r.latest?.toISOString().slice(0,10)}`);
  });

  const overall = await client.query(`
    SELECT MIN(report_month::date) as overall_min, MAX(report_month::date) as overall_max, COUNT(DISTINCT dealer_code) as dealer_count
    FROM public.hyundai_operation_wise_analysis_report
  `);
  const o = overall.rows[0];
  console.log();
  console.log(`Overall: ${o.dealer_count} dealers  |  ${o.overall_min?.toISOString().slice(0,10)} to ${o.overall_max?.toISOString().slice(0,10)}`);
});
