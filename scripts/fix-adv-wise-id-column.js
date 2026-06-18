import { config } from '../src/config.js';
import { withPostgresClient } from '../src/supabase/postgres.js';
import { normalizeTableName } from '../src/supabase/relational-store.js';

const tableName = normalizeTableName(config.advWiseLubricantsVasSheetName);

await withPostgresClient(async client => {
  const exists = await client.query(
    `
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = $1
    `,
    [tableName]
  );

  if (!exists.rows.length) {
    console.log(`Table ${tableName} does not exist yet`);
    return;
  }

  const { rows } = await client.query(
    `
      select column_default, is_identity
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
        and column_name = 'id'
    `,
    [tableName]
  );

  if (!rows.length) {
    console.log(`Table ${tableName} has no id column`);
    return;
  }

  const { column_default: columnDefault, is_identity: isIdentity } = rows[0];
  if (columnDefault || isIdentity === 'YES') {
    console.log(`Table ${tableName}.id already auto-generates`);
    return;
  }

  const sequenceName = `${tableName}_id_seq`;
  await client.query(`create sequence if not exists ${sequenceName}`);
  await client.query(`
    alter table public.${tableName}
    alter column id set default nextval('public.${sequenceName}'::regclass)
  `);
  await client.query(`alter sequence ${sequenceName} owned by public.${tableName}.id`);
  await client.query(`
    select setval(
      'public.${sequenceName}'::regclass,
      coalesce((select max(id) from public.${tableName}), 0) + 1,
      false
    )
  `);

  console.log(`Repaired ${tableName}.id default using ${sequenceName}`);
});
