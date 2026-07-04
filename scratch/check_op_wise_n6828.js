import { withPostgresClient } from '../src/supabase/postgres.js';

try {
  await withPostgresClient(async client => {
    const result = await client.query(`
      SELECT report_type, report_period_start, count(*)::int as row_count
      FROM public.am_platinum_operation_wise_analysis_report
      WHERE upper(trim(source_dealer_code::text)) = 'N6828'
      GROUP BY report_type, report_period_start
      ORDER BY report_type, report_period_start DESC
      LIMIT 15
    `);
    
    console.log('Last 15 months of records for N6828:');
    for (const row of result.rows) {
      const dateStr = row.report_period_start instanceof Date 
        ? row.report_period_start.toISOString().split('T')[0]
        : String(row.report_period_start);
      console.log(`Type: ${row.report_type} | Start Date: ${dateStr} | Rows: ${row.row_count}`);
    }
  });
} catch (error) {
  console.error('❌ Error checking records:', error.message);
}
