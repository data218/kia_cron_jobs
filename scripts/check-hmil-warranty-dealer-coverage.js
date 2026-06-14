import { withPostgresClient } from '../src/supabase/postgres.js';
import { config } from '../src/config.js';

const dealerArg = process.argv[2] || 'N5203';
const dealer = String(dealerArg).trim().toUpperCase();
const tables = ['hyundai_warranty_claim_list', 'hyundai_warranty_claim_ytp'];
const expectedStart = config.hmilWarrantyHistoricalStartDate || '2025-01-01';
const today = new Date().toISOString().slice(0, 10);

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

await withPostgresClient(async client => {
  console.log('\nHMIL Warranty coverage check');
  console.log(`Dealer: ${dealer}`);
  console.log(`Expected range: ${expectedStart} to ${today}`);
  console.log('');

  const missing = [];

  for (const table of tables) {
    const exists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [table]
    );

    if (!exists.rows[0]?.exists) {
      console.log(`${table}: TABLE MISSING`);
      missing.push({ table, reason: 'table missing' });
      continue;
    }

    const cols = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    const colNames = cols.rows.map(row => row.column_name);
    const dealerCol = colNames.includes('source_dealer_code')
      ? 'source_dealer_code'
      : (colNames.includes('dealer_code') ? 'dealer_code' : null);
    const dateCol = ['claim_date', 'ro_date', 'report_date'].find(name => colNames.includes(name)) || null;

    const total = await client.query(`SELECT COUNT(*)::int AS cnt FROM public.${quoteIdentifier(table)}`);
    console.log(`${table}`);
    console.log(`  Total rows in table: ${total.rows[0].cnt}`);

    if (!dealerCol) {
      console.log('  WARNING: no dealer column found');
      missing.push({ table, reason: 'no dealer column' });
      console.log('');
      continue;
    }

    const dealerRows = await client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM public.${quoteIdentifier(table)}
       WHERE upper(trim(${quoteIdentifier(dealerCol)}::text)) = upper(trim($1::text))`,
      [dealer]
    );
    const rowCount = Number(dealerRows.rows[0]?.cnt ?? 0);

    let minDate = null;
    let maxDate = null;
    if (dateCol && rowCount > 0) {
      const dates = await client.query(
        `SELECT MIN(${quoteIdentifier(dateCol)})::date AS min_date,
                MAX(${quoteIdentifier(dateCol)})::date AS max_date
         FROM public.${quoteIdentifier(table)}
         WHERE upper(trim(${quoteIdentifier(dealerCol)}::text)) = upper(trim($1::text))`,
        [dealer]
      );
      minDate = dates.rows[0]?.min_date;
      maxDate = dates.rows[0]?.max_date;
    }

    const complete = rowCount > 0 && (!minDate || String(minDate) <= expectedStart);
    const status = complete ? 'OK' : 'MISSING / INCOMPLETE';
    console.log(`  ${dealer}: ${rowCount} rows | ${status}`);
    if (dateCol) {
      console.log(`  Date range (${dateCol}): ${minDate ?? 'n/a'} to ${maxDate ?? 'n/a'}`);
    }

    if (!complete) {
      missing.push({
        table,
        reason: rowCount === 0 ? 'no rows' : `starts ${minDate ?? 'unknown'} (need from ${expectedStart})`
      });
    }

    console.log('');
  }

  console.log('Summary');
  if (missing.length === 0) {
    console.log(`  ${dealer}: both warranty tables look populated.`);
  } else {
    console.log(`  ${dealer}: needs backfill for:`);
    for (const item of missing) {
      console.log(`    - ${item.table}: ${item.reason}`);
    }
  }
  console.log('');
});
