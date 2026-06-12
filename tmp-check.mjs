import { config } from './src/config.js';
import { withPostgresClient } from './src/supabase/postgres.js';
import { normalizeTableName } from './src/supabase/relational-store.js';

const reports = [
  { id: 'Repair Order List', sheet: 'AM Platinum Repair Order List' },
  { id: 'RO Billing', sheet: 'AM Platinum RO Billing Report' },
  { id: 'Operation Wise', sheet: 'AM Platinum Operation Wise Analysis' }
];

await withPostgresClient(async client => {
  for (const r of reports) {
    const tbl = normalizeTableName(r.sheet);
    const exists = (await client.query(`select exists (select 1 from information_schema.tables where table_schema='public' and table_name=$1) as e`, [tbl])).rows[0].e;
    if (!exists) { console.log(r.id + ': table not found'); continue; }
    const cols = (await client.query(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [tbl])).rows;
    const dateCol = cols.find(c => c.column_name.includes('date') || c.column_name.includes('year') || c.column_name.includes('month'));
    const total = (await client.query(`select count(*)::int as c from public.${tbl}`)).rows[0].c;
    const n6824 = (await client.query(`select count(*)::int as c from public.${tbl} where upper(source_dealer_code)='N6824'`)).rows[0].c;
    let after2024 = 'N/A';
    if (dateCol) {
      after2024 = (await client.query(`select count(*)::int as c from public.${tbl} where upper(source_dealer_code)='N6824' and ${dateCol.column_name} >= '2024-04-01'`)).rows[0].c;
    }
    console.log(r.id + ': total=' + total + ', N6824=' + n6824 + ', N6824>=2024-04=' + after2024 + ', dateCol=' + (dateCol?.column_name || 'none'));
  }
});
