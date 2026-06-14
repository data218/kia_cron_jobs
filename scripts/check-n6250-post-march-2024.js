import 'dotenv/config';
import { withPostgresClient } from '../src/supabase/postgres.js';

const DEALER = 'N6250';
const CUTOFF = '2024-03-01';

async function countQuery(client, label, sql, params = []) {
  const result = await client.query(sql, params);
  const row = result.rows[0];
  console.log(`\n${label}`);
  console.log(`  rows: ${row.cnt}`);
  if (row.min_date) console.log(`  min date: ${row.min_date}`);
  if (row.max_date) console.log(`  max_date: ${row.max_date}`);
  if (row.distinct_months != null) console.log(`  distinct months: ${row.distinct_months}`);
}

async function main() {
  console.log(`N6250 post-${CUTOFF} spot check`);

  await withPostgresClient(async client => {
    await countQuery(
      client,
      'Operation Wise — Part (report_period_start >= cutoff)',
      `
        SELECT COUNT(*)::int AS cnt,
               MIN(report_period_start)::date AS min_date,
               MAX(COALESCE(report_period_end, report_period_start))::date AS max_date,
               COUNT(DISTINCT LEFT(COALESCE(NULLIF(report_month::text, ''), to_char(report_period_start, 'YYYY-MM')), 7))::int AS distinct_months
        FROM public.am_platinum_operation_wise_analysis_report
        WHERE upper(trim(source_dealer_code::text)) = $1
          AND report_type = 'Part'
          AND report_period_start >= $2::date
      `,
      [DEALER, CUTOFF]
    );

    await countQuery(
      client,
      'RO Billing (dealer_code, bill_date >= cutoff)',
      `
        SELECT COUNT(*)::int AS cnt,
               MIN(bill_date)::date AS min_date,
               MAX(bill_date)::date AS max_date
        FROM public.am_platinum_ro_billing_report
        WHERE upper(trim(dealer_code::text)) = $1
          AND bill_date >= $2::date
      `,
      [DEALER, CUTOFF]
    );

    await countQuery(
      client,
      'Repair Order List (source_dealer_code, r_o_date >= cutoff)',
      `
        SELECT COUNT(*)::int AS cnt,
               MIN(r_o_date)::date AS min_date,
               MAX(r_o_date)::date AS max_date
        FROM public.am_platinum_repair_order_list
        WHERE upper(trim(source_dealer_code::text)) = $1
          AND r_o_date >= $2::date
      `,
      [DEALER, CUTOFF]
    );

    await countQuery(
      client,
      'Customer Complaint List (source_dealer_code, complaint_date >= cutoff)',
      `
        SELECT COUNT(*)::int AS cnt,
               MIN(complaint_date)::date AS min_date,
               MAX(complaint_date)::date AS max_date
        FROM public.am_platinum_customer_complaint_list
        WHERE upper(trim(source_dealer_code::text)) = $1
          AND complaint_date >= $2::date
      `,
      [DEALER, CUTOFF]
    );

    const legacy = await client.query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM (
          SELECT dealer_code AS code FROM public.am_platinum_ro_billing_report WHERE upper(trim(dealer_code::text)) = 'N6824'
          UNION ALL
          SELECT source_dealer_code FROM public.am_platinum_operation_wise_analysis_report WHERE upper(trim(source_dealer_code::text)) = 'N6824'
        ) t
      `
    );
    console.log(`\nLegacy N6824 rows (should be 0): ${legacy.rows[0].cnt}`);
  });
}

main().catch(error => {
  console.error('Spot check failed:', error);
  process.exit(1);
});
