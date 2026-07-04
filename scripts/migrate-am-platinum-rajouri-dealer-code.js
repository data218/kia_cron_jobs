import 'dotenv/config';
import { AM_PLATINUM_TABLES } from '../src/supabase/row-identity.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';

const OLD_CODE = 'N6824';
const NEW_CODE = 'N6250';
const DEALER_COLUMNS = ['source_dealer_code', 'dealer_code'];

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run') || !argv.includes('--apply'),
    apply: argv.includes('--apply')
  };
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  return result.rowCount > 0;
}

async function getTableColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
    `,
    [tableName]
  );
  return new Set(result.rows.map(row => row.column_name));
}

async function countRowsForColumn(client, tableName, columnName) {
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS cnt
      FROM public.${quoteIdentifier(tableName)}
      WHERE upper(trim(${quoteIdentifier(columnName)}::text)) = $1
    `,
    [OLD_CODE]
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

async function migrateColumn(client, tableName, columnName, dryRun) {
  const count = await countRowsForColumn(client, tableName, columnName);
  if (count === 0) {
    return { columnName, count, updated: 0 };
  }

  if (dryRun) {
    return { columnName, count, updated: 0 };
  }

  const result = await client.query(
    `
      UPDATE public.${quoteIdentifier(tableName)}
      SET ${quoteIdentifier(columnName)} = $1
      WHERE upper(trim(${quoteIdentifier(columnName)}::text)) = $2
    `,
    [NEW_CODE, OLD_CODE]
  );

  return { columnName, count, updated: result.rowCount ?? 0 };
}

async function main() {
  const { dryRun, apply } = parseArgs(process.argv.slice(2));

  if (!dryRun && !apply) {
    console.error('Pass --dry-run (default) or --apply');
    process.exit(1);
  }

  console.log(`Rajouri dealer code migration: ${OLD_CODE} -> ${NEW_CODE}`);
  console.log(`Mode: ${dryRun ? 'dry-run' : 'apply'}\n`);

  let totalMatches = 0;
  let totalUpdated = 0;

  await withPostgresClient(async client => {
    for (const tableName of AM_PLATINUM_TABLES) {
      if (!(await tableExists(client, tableName))) {
        console.log(`${tableName}: table missing`);
        continue;
      }

      const columns = await getTableColumns(client, tableName);
      const dealerColumns = DEALER_COLUMNS.filter(column => columns.has(column));

      if (dealerColumns.length === 0) {
        console.log(`${tableName}: no dealer columns`);
        continue;
      }

      const columnResults = [];
      for (const columnName of dealerColumns) {
        columnResults.push(await migrateColumn(client, tableName, columnName, dryRun));
      }

      const tableMatches = columnResults.reduce((sum, row) => sum + row.count, 0);
      const tableUpdated = columnResults.reduce((sum, row) => sum + row.updated, 0);
      totalMatches += tableMatches;
      totalUpdated += tableUpdated;

      const details = columnResults
        .map(row => `${row.columnName}=${row.count}${dryRun ? '' : ` updated=${row.updated}`}`)
        .join(', ');
      console.log(`${tableName}: ${details || '0 rows'}`);
    }
  });

  console.log(`\nTotal ${OLD_CODE} rows matched: ${totalMatches}`);
  if (!dryRun) {
    console.log(`Total rows updated: ${totalUpdated}`);
    console.log('\nNext: npm run am-platinum:dedupe:dry-run && npm run am-platinum:dedupe');
  } else {
    console.log('\nRe-run with --apply to perform updates.');
  }
}

main().catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
});
