import { withPostgresClient } from '../src/supabase/postgres.js';
import { normalizeTableName } from '../src/supabase/relational-store.js';

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return result.rows[0].exists;
}

async function main() {
  const tableName = normalizeTableName('AM Platinum Operation Wise Analysis Report');
  console.log(`\n=== Checking table: ${tableName} ===\n`);

  await withPostgresClient(async (client) => {
    const exists = await tableExists(client, tableName);
    if (!exists) {
      console.log(`❌ Table "${tableName}" does NOT exist in the database.`);
      console.log(`   → Backfill is needed (no data at all).`);
      return;
    }

    const countResult = await client.query(`SELECT COUNT(*)::int as cnt FROM "${tableName}"`);
    const totalCount = countResult.rows[0].cnt;
    console.log(`✅ Table "${tableName}" exists.`);
    console.log(`   Total rows: ${totalCount}`);

    if (totalCount === 0) {
      console.log(`   ⚠️  Table is EMPTY. Backfill needed.`);
      return;
    }

    // Show dealer breakdown
    const dealerResult = await client.query(`
      SELECT source_dealer_code, COUNT(*)::int as cnt,
             MIN(report_period_start) as min_period,
             MAX(report_period_end) as max_period,
             COUNT(DISTINCT report_type) as type_count,
             COUNT(DISTINCT report_month) as month_count
      FROM "${tableName}"
      GROUP BY source_dealer_code
      ORDER BY source_dealer_code
    `);

    for (const row of dealerResult.rows) {
      console.log(`\n   Dealer: ${row.source_dealer_code}`);
      console.log(`     Rows: ${row.cnt}`);
      console.log(`     Date range: ${row.min_period} to ${row.max_period}`);
      console.log(`     Report types: ${row.type_count}`);
      console.log(`     Months covered: ${row.month_count}`);
    }

    // Check report type coverage
    const typeResult = await client.query(`
      SELECT report_type, COUNT(*)::int as cnt,
             MIN(report_period_start) as min_period,
             MAX(report_period_end) as max_period
      FROM "${tableName}"
      GROUP BY report_type
      ORDER BY report_type
    `);

    console.log(`\n   Report type breakdown:`);
    for (const row of typeResult.rows) {
      console.log(`     ${row.report_type || '(null)'}: ${row.cnt} rows (${row.min_period} to ${row.max_period})`);
    }

    const hasBothTypes = typeResult.rows.length >= 2;
    const hasOperation = typeResult.rows.some(r => r.report_type === 'Operation');
    const hasPart = typeResult.rows.some(r => r.report_type === 'Part');

    console.log(`\n   Coverage summary:`);
    console.log(`     Operation type: ${hasOperation ? '✅' : '❌'}`);
    console.log(`     Part type: ${hasPart ? '✅' : '❌'}`);
    console.log(`     Both types: ${hasBothTypes ? '✅' : '❌ - need backfill for missing type(s)'}`);
  });
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});