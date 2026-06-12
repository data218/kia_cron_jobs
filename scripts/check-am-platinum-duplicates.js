import { withPostgresClient } from '../src/supabase/postgres.js';

const tables = [
  'am_platinum_repair_order_list',
  'am_platinum_ro_billing_report',
  'am_platinum_call_center_complaints',
  'am_platinum_demo_car_list',
  'am_platinum_service_appointment',
  'am_platinum_trust_package',
  'am_platinum_psf_yearly',
  'am_platinum_ew_report',
  'am_platinum_adv_wise_lubricants_vas',
  'am_platinum_operation_wise_analysis_report'
];

await withPostgresClient(async (client) => {
  console.log('');
  console.log('═'.repeat(85));
  console.log('  AM PLATINUM DUPLICATE CHECK (row_hash uniqueness)');
  console.log('═'.repeat(85));
  console.log('');
  console.log(`  ${'Table'.padEnd(45)} | ${'Total'.padStart(6)} | ${'Unique'.padStart(6)} | ${'Dupes'.padStart(5)} | Status`);
  console.log(`  ${'-'.repeat(43)}-|--------|--------|-------|----------`);

  let totalDupes = 0;
  let totalRows = 0;

  for (const table of tables) {
    const rowCountRes = await client.query(`SELECT COUNT(*)::int as total FROM "${table}"`);
    const hashCountRes = await client.query(`SELECT COUNT(DISTINCT row_hash)::int as unique_hashes FROM "${table}"`);
    const nullHashRes = await client.query(`SELECT COUNT(*)::int as cnt FROM "${table}" WHERE row_hash IS NULL`);

    const total = rowCountRes.rows[0].total;
    const unique = hashCountRes.rows[0].unique_hashes;
    const nullHashes = nullHashRes.rows[0].cnt;
    const dupes = total - unique;
    const status = dupes === 0 && nullHashes === 0 ? '✅ CLEAN' : dupes > 0 ? '❌ DUPLICATES' : '⚠️  NULL HASHES';

    totalDupes += dupes;
    totalRows += total;

    console.log(`  ${table.padEnd(45)} | ${String(total).padStart(6)} | ${String(unique).padStart(6)} | ${String(dupes).padStart(5)} | ${status}`);
    if (nullHashes > 0) {
      console.log(`  ${' '.repeat(45)} |        |        |       | ⚠️  ${nullHashes} rows with NULL row_hash`);
    }
  }

  console.log(`  ${'-'.repeat(43)}-|--------|--------|-------|----------`);
  console.log('');
  console.log(`  Total rows scanned : ${totalRows}`);
  console.log(`  Total duplicates   : ${totalDupes}`);
  console.log(`  Overall status     : ${totalDupes === 0 ? '✅ ALL CLEAN' : '❌ DUPLICATES FOUND'}`);
  console.log('');
});
