import { withPostgresClient } from '../src/supabase/postgres.js';

const tables = ['hyundai_warranty_claim_list', 'hyundai_warranty_claim_ytp'];

await withPostgresClient(async client => {
  for (const table of tables) {
    console.log(`\n=== ${table} ===`);
    const total = await client.query(`SELECT COUNT(*)::int AS c FROM public.${table}`);
    console.log('Total rows:', total.rows[0].c);

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    const dateCol = cols.rows.map(r => r.column_name).find(c =>
      ['claim_date', 'ro_date', 'report_date'].includes(c)
    ) || 'claim_date';

    const byMonth = await client.query(`
      SELECT to_char(${dateCol}::date, 'YYYY-MM') AS ym, COUNT(*)::int AS cnt
      FROM public.${table}
      WHERE ${dateCol} IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `);
    console.log(`By ${dateCol} month:`);
    if (!byMonth.rows.length) console.log('  (empty)');
    for (const r of byMonth.rows) console.log(`  ${r.ym}: ${r.cnt}`);

    const byDealer = await client.query(`
      SELECT upper(trim(source_dealer_code::text)) AS dealer,
             COUNT(*)::int AS cnt,
             MIN(${dateCol})::date AS min_d,
             MAX(${dateCol})::date AS max_d
      FROM public.${table}
      GROUP BY 1 ORDER BY 1
    `);
    console.log('By dealer:');
    for (const r of byDealer.rows) {
      console.log(`  ${r.dealer}: ${r.cnt} rows (${r.min_d} -> ${r.max_d})`);
    }
  }
});
