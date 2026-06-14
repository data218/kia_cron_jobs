import 'dotenv/config';
import { withPostgresClient } from '../src/supabase/postgres.js';

const tables = [
  'am_platinum_repair_order_list',
  'am_platinum_ro_billing_report',
  'am_platinum_call_center_complaints',
  'am_platinum_customer_complaint_list',
  'am_platinum_demo_car_list',
  'am_platinum_service_appointment',
  'am_platinum_trust_package',
  'am_platinum_psf_yearly',
  'am_platinum_ew_report',
  'am_platinum_adv_wise_lubricants_vas',
  'am_platinum_operation_wise_analysis_report'
];

await withPostgresClient(async (client) => {
  for (const table of tables) {
    const cols = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table]
    );
    const dealerCols = cols.rows.filter(c => /dealer|source_/.test(c.column_name));
    const dateCols = cols.rows.filter(c => c.data_type === 'date' || c.data_type.includes('timestamp'));

    console.log(`\n${table}`);
    console.log(`  dealer cols: ${dealerCols.map(c => c.column_name).join(', ') || 'none'}`);
    console.log(`  date cols: ${dateCols.map(c => `${c.column_name}:${c.data_type}`).join(', ') || 'none'}`);

    for (const dc of ['source_dealer_code', 'dealer_code']) {
      if (!dealerCols.some(c => c.column_name === dc)) continue;
      const r = await client.query(
        `SELECT "${dc}", COUNT(*)::int AS cnt FROM public."${table}" GROUP BY 1 ORDER BY cnt DESC LIMIT 10`
      );
      console.log(`  ${dc}: ${r.rows.map(x => `${x[dc]}=${x.cnt}`).join(', ')}`);
    }
  }
});
