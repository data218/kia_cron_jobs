import { withPostgresClient } from '../src/supabase/postgres.js';

const tables = ['hyundai_warranty_claim_list', 'hyundai_warranty_claim_ytp'];

await withPostgresClient(async client => {
  for (const table of tables) {
    console.log(`\n=== ${table} ===`);
    const cols = await client.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    const names = cols.rows.map(row => row.column_name);
    console.log('Columns:', names.join(', '));
    console.log('Has source_dealer_code:', names.includes('source_dealer_code'));
    console.log('Has dealer_code:', names.includes('dealer_code'));

    const total = await client.query(`SELECT COUNT(*)::int AS c FROM public.${table}`);
    console.log('Total rows:', total.rows[0].c);

    for (const column of ['source_dealer_code', 'dealer_code']) {
      if (!names.includes(column)) {
        console.log(`Column ${column}: NOT IN TABLE`);
        continue;
      }
      const blank = await client.query(
        `SELECT COUNT(*)::int AS c
         FROM public.${table}
         WHERE ${column} IS NULL
            OR TRIM(${column}::text) = ''
            OR UPPER(TRIM(${column}::text)) IN ('ACTIVE', 'CURRENT', 'DEFAULT')`
      );
      console.log(`Rows missing/invalid ${column}:`, blank.rows[0].c);
    }
  }
});
