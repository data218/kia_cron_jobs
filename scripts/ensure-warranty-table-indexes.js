import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';

const tables = ['hyundai_warranty_claim_list', 'hyundai_warranty_claim_ytp'];

await withPostgresClient(async client => {
  for (const tableName of tables) {
    const table = `public.${quoteIdentifier(tableName)}`;
    await client.query(`
      alter table ${table}
      add column if not exists business_identity_key text
    `);
    await client.query(`
      create unique index if not exists ${quoteIdentifier(`idx_${tableName}_business_identity_key`)}
      on ${table}(business_identity_key)
      where business_identity_key is not null
    `);
    await client.query(`
      create unique index if not exists ${quoteIdentifier(`idx_${tableName}_row_hash`)}
      on ${table}(row_hash)
    `);
    console.log(`Ensured warranty indexes on ${tableName}`);
  }
});
