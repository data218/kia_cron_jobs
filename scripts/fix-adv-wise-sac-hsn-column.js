import { config } from '../src/config.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';
import { normalizeTableName } from '../src/supabase/relational-store.js';

const tableName = normalizeTableName(config.advWiseLubricantsVasSheetName);

await withPostgresClient(async client => {
  const result = await client.query(
    `
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
      order by ordinal_position
    `,
    [tableName]
  );

  if (!result.rows.length) {
    console.log(`Table ${tableName} does not exist yet`);
    return;
  }

  const textLikeColumns = result.rows.filter(row =>
    row.data_type !== 'text' &&
    (row.column_name.endsWith('_hsn') || row.column_name.endsWith('_code') || row.column_name.endsWith('_no'))
  );

  if (!textLikeColumns.length) {
    console.log(`No numeric code/hsn columns to fix in ${tableName}`);
    return;
  }

  const table = `public.${quoteIdentifier(tableName)}`;
  for (const column of textLikeColumns) {
    await client.query(`
      alter table ${table}
      alter column ${quoteIdentifier(column.column_name)} type text
      using ${quoteIdentifier(column.column_name)}::text
    `);
    console.log(`Altered ${column.column_name}: ${column.data_type} -> text`);
  }
});
