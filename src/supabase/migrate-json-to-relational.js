import 'dotenv/config';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { quoteIdentifier, withPostgresClient } from './postgres.js';
import { saveReportSheetToRelationalTable } from './relational-store.js';

function requestedSheets() {
  return process.argv
    .slice(2)
    .map(value => value.trim())
    .filter(Boolean);
}

async function fetchJsonSheets(sheetNames) {
  return withPostgresClient(async client => {
    await client.query('set statement_timeout = 0');
    const values = [];
    let filterSql = '';

    if (sheetNames.length) {
      values.push(sheetNames);
      filterSql = 'and sheet_name = any($1::text[])';
    }

    const result = await client.query(
      `
        select brand, sheet_name, headers, rows, uploaded_at
        from public.${quoteIdentifier(config.supabaseReportsTable)}
        where brand = 'kia'
        ${filterSql}
        order by sheet_name asc
      `,
      values
    );

    return result.rows;
  });
}

async function main() {
  const sheetNames = requestedSheets();
  logger.info('Starting JSON-to-relational migration', {
    sheetNames: sheetNames.length ? sheetNames : 'all'
  });

  const sheets = await fetchJsonSheets(sheetNames);
  const results = [];

  for (const sheet of sheets) {
    const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];

    if (!headers.length) {
      logger.warn('Skipping JSON sheet without headers', {
        sheetName: sheet.sheet_name
      });
      continue;
    }

    logger.info('Migrating JSON sheet to relational table', {
      sheetName: sheet.sheet_name,
      headerCount: headers.length,
      rowCount: rows.length
    });

    const result = await saveReportSheetToRelationalTable({
      sheetName: sheet.sheet_name,
      headers,
      rows
    });
    results.push({
      sheetName: sheet.sheet_name,
      ...result
    });
  }

  logger.info('JSON-to-relational migration completed', {
    sheetCount: results.length,
    results
  });

  console.log(JSON.stringify({
    migratedSheets: results.length,
    results
  }, null, 2));
}

main().catch(error => {
  logger.error('JSON-to-relational migration failed', error);
  process.exitCode = 1;
});
