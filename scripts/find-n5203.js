import { withPostgresClient } from '../src/supabase/postgres.js';

await withPostgresClient(async client => {
  const tables = await client.query(`
    select table_name 
    from information_schema.tables 
    where table_schema = 'public' 
      and (table_name LIKE 'hyundai_%' or table_name = 'trust_package')
  `);
  
  console.log('Searching for source_dealer_code = N5203 across tables...');
  for (const row of tables.rows) {
    const tableName = row.table_name;
    try {
      const cols = await client.query(`
        select column_name 
        from information_schema.columns 
        where table_schema = 'public' 
          and table_name = $1 
          and column_name = 'source_dealer_code'
      `, [tableName]);
      
      if (cols.rowCount > 0) {
        const countRes = await client.query(`
          select count(*) as count 
          from public."${tableName}" 
          where source_dealer_code = 'N5203'
        `);
        const count = parseInt(countRes.rows[0].count);
        if (count > 0) {
          console.log(`  Table "${tableName}": found ${count} rows with source_dealer_code = 'N5203'`);
        }
      }
    } catch (e) {
      // ignore table errors
    }
  }
  console.log('Search complete.');
});
