import { withPostgresClient } from '../src/supabase/postgres.js';

const AM_PLATINUM_TABLES = [
  'am_platinum_repair_order_list',
  'am_platinum_ro_billing_report',
  'am_platinum_call_center_complaints',
  'am_platinum_customer_complaint_list',
  'am_platinum_open_ro_yearly',
  'am_platinum_demo_job_cards',
  'am_platinum_demo_car_list',
  'am_platinum_service_appointment',
  'am_platinum_psf_yearly',
  'am_platinum_ew_report',
  'am_platinum_mcp_report',
  'am_platinum_adv_wise_lubricants_vas',
  'am_platinum_operation_wise_analysis_report',
  'am_platinum_trust_package'
];

async function checkTable(client, tableName) {
  try {
    const countResult = await client.query(`SELECT COUNT(*)::int as cnt FROM "${tableName}"`);
    const totalCount = countResult.rows[0].cnt;

    if (totalCount === 0) {
      return { table: tableName, totalRows: 0, dealers: [] };
    }

    const dealerResult = await client.query(`
      SELECT source_dealer_code, COUNT(*)::int as cnt,
             MIN(uploaded_at) as first_seen, MAX(uploaded_at) as last_seen
      FROM "${tableName}"
      GROUP BY source_dealer_code
      ORDER BY source_dealer_code
    `);

    return {
      table: tableName,
      totalRows: totalCount,
      dealers: dealerResult.rows.map(r => ({
        dealerCode: r.source_dealer_code,
        rowCount: r.cnt,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen
      }))
    };
  } catch (err) {
    return { table: tableName, error: err.message };
  }
}

async function main() {
  console.log('=== AM Platinum Table Data Check ===');
  console.log();

  await withPostgresClient(async (client) => {
    for (const tableName of AM_PLATINUM_TABLES) {
      const result = await checkTable(client, tableName);
      if (result.error) {
        console.log(`❌ ${result.table}: ERROR - ${result.error}`);
      } else if (result.totalRows === 0) {
        console.log(`❌ ${result.table}: 0 rows (EMPTY)`);
      } else {
        console.log(`✅ ${result.table}: ${result.totalRows} total rows`);
        for (const d of result.dealers) {
          console.log(`   ${d.dealerCode}: ${d.rowCount} rows (${d.firstSeen} to ${d.lastSeen})`);
        }
      }
      console.log();
    }
  });
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
