import 'dotenv/config';
import { withPostgresClient } from '../src/supabase/postgres.js';

const DEALERS = ['N5211', 'N6250', 'N6828'];
const START = '2021-01-01';
const END = new Date().toISOString().slice(0, 10);

const TABLES = [
  { table: 'am_platinum_repair_order_list', dateColumns: ['ro_date', 'r_o_date'] },
  { table: 'am_platinum_ro_billing_report', dateColumns: ['bill_date'] },
  { table: 'am_platinum_call_center_complaints', dateColumns: ['complaint_date', 'complaint_received_date'] },
  { table: 'am_platinum_customer_complaint_list', dateColumns: ['complaint_date'] },
  { table: 'am_platinum_open_ro_yearly', dateColumns: ['ro_date', 'r_o_date'] },
  { table: 'am_platinum_demo_job_cards', dateColumns: ['ro_date', 'r_o_date'] },
  { table: 'am_platinum_demo_car_list', dateColumns: ['purchase_date', 'invoice_date', 'reg_date'] },
  { table: 'am_platinum_service_appointment', dateColumns: ['appointment_date', 'appointement_date', 'booking_date'] },
  { table: 'am_platinum_trust_package', dateColumns: ['package_purchase_date', 'purchase_date'] },
  { table: 'am_platinum_psf_yearly', dateColumns: ['psf_date', 'survey_date', 'ro_date'] },
  { table: 'am_platinum_ew_report', dateColumns: ['ew_date', 'purchase_date', 'invoice_date'] },
  { table: 'am_platinum_mcp_report', dateColumns: ['mcp_date', 'purchase_date'] },
  { table: 'am_platinum_adv_wise_lubricants_vas', dateColumns: ['report_month', 'bill_date', 'ro_date'] },
  { table: 'am_platinum_operation_wise_analysis_report', dateColumns: ['report_month', 'bill_date', 'ro_date'] }
];

function monthKeys(from = START, to = END) {
  const keys = [];
  const [sy, sm] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}

const ALL_MONTHS = monthKeys();

async function tableExists(client, tableName) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return res.rows.length > 0;
}

async function resolveDateColumn(client, tableName, candidates) {
  const res = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  const cols = new Map(res.rows.map(r => [r.column_name.toLowerCase(), r]));
  for (const candidate of candidates) {
    if (cols.has(candidate.toLowerCase())) {
      return { column: cols.get(candidate.toLowerCase()).column_name, dataType: cols.get(candidate.toLowerCase()).data_type };
    }
  }
  const dateCols = res.rows.filter(r => r.data_type === 'date' || r.data_type.includes('timestamp'));
  if (dateCols.length === 1) return { column: dateCols[0].column_name, dataType: dateCols[0].data_type };
  return null;
}

async function analyzeTable(client, { table, dateColumns }) {
  if (!(await tableExists(client, table))) {
    return { table, exists: false };
  }

  const dateInfo = await resolveDateColumn(client, table, dateColumns);
  const totalRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM public."${table}"`);
  const totalRows = totalRes.rows[0].cnt;

  const dealerRes = await client.query(`
    SELECT source_dealer_code, COUNT(*)::int AS cnt
    FROM public."${table}"
    GROUP BY source_dealer_code
    ORDER BY source_dealer_code
  `);

  const dealerCounts = Object.fromEntries(DEALERS.map(d => [d, 0]));
  for (const row of dealerRes.rows) {
    if (row.source_dealer_code) dealerCounts[row.source_dealer_code] = row.cnt;
  }

  if (!dateInfo || totalRows === 0) {
    return {
      table,
      exists: true,
      totalRows,
      dealerCounts,
      dateColumn: dateInfo?.column ?? null,
      hasHistoricalRange: false,
      dealers: DEALERS.map(dealer => ({
        dealer,
        rows: dealerCounts[dealer] || 0,
        minDate: null,
        maxDate: null,
        monthsPresent: 0,
        monthsExpected: ALL_MONTHS.length,
        missingMonths: dealerCounts[dealer] ? [] : ALL_MONTHS,
        status: dealerCounts[dealer] ? 'no_date_column' : 'no_data'
      }))
    };
  }

  const { column: dateCol, dataType } = dateInfo;
  const monthExpr = dataType === 'date'
    ? `to_char("${dateCol}", 'YYYY-MM')`
    : `to_char(date_trunc('month', "${dateCol}"::timestamp), 'YYYY-MM')`;

  const dealers = [];
  for (const dealer of DEALERS) {
    const rangeRes = await client.query(`
      SELECT MIN("${dateCol}")::date AS min_date, MAX("${dateCol}")::date AS max_date, COUNT(*)::int AS cnt
      FROM public."${table}"
      WHERE source_dealer_code = $1 AND "${dateCol}" IS NOT NULL
    `, [dealer]);

    const rows = rangeRes.rows[0].cnt;
    const minDate = rangeRes.rows[0].min_date;
    const maxDate = rangeRes.rows[0].max_date;

    if (!rows) {
      dealers.push({
        dealer,
        rows: dealerCounts[dealer] || 0,
        minDate: null,
        maxDate: null,
        monthsPresent: 0,
        monthsExpected: ALL_MONTHS.length,
        missingMonths: ALL_MONTHS,
        status: 'no_data'
      });
      continue;
    }

    const monthRes = await client.query(`
      SELECT ${monthExpr} AS month_key, COUNT(*)::int AS cnt
      FROM public."${table}"
      WHERE source_dealer_code = $1 AND "${dateCol}" IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `, [dealer]);

    const present = new Set(monthRes.rows.map(r => r.month_key));
    const missingMonths = ALL_MONTHS.filter(m => !present.has(m));

    let status = 'full_historical';
    if (minDate > new Date(START) || maxDate < new Date(END)) status = 'partial_range';
    if (missingMonths.length > ALL_MONTHS.length * 0.5) status = 'sparse';
    if (minDate >= new Date('2026-06-01')) status = 'current_month_only';

    dealers.push({
      dealer,
      rows,
      minDate: minDate?.toISOString?.().slice(0, 10) ?? String(minDate),
      maxDate: maxDate?.toISOString?.().slice(0, 10) ?? String(maxDate),
      monthsPresent: present.size,
      monthsExpected: ALL_MONTHS.length,
      missingMonths,
      status
    });
  }

  const hasHistoricalRange = dealers.some(d =>
    d.status === 'full_historical' || d.status === 'partial_range' || d.status === 'sparse'
  ) && !dealers.every(d => d.status === 'current_month_only' || d.status === 'no_data');

  return {
    table,
    exists: true,
    totalRows,
    dealerCounts,
    dateColumn: dateCol,
    hasHistoricalRange,
    dealers
  };
}

function formatMissing(missing, limit = 12) {
  if (!missing.length) return 'none';
  if (missing.length <= limit) return missing.join(', ');
  return `${missing.slice(0, limit).join(', ')} ... (+${missing.length - limit} more)`;
}

async function main() {
  console.log('\nAM PLATINUM HISTORICAL COVERAGE ANALYSIS');
  console.log(`Range: ${START} → ${END}`);
  console.log(`Dealers: ${DEALERS.join(', ')}`);
  console.log(`Expected months: ${ALL_MONTHS.length} (${ALL_MONTHS[0]} … ${ALL_MONTHS.at(-1)})\n`);

  await withPostgresClient(async (client) => {
    const results = [];
    for (const entry of TABLES) {
      results.push(await analyzeTable(client, entry));
    }

    console.log('='.repeat(120));
    console.log('TABLE SUMMARY');
    console.log('='.repeat(120));
    console.log(
      'Table'.padEnd(42) +
      'Exists'.padEnd(8) +
      'Rows'.padStart(8) +
      'N5211'.padStart(8) +
      'N6250'.padStart(8) +
      'N6828'.padStart(8) +
      '  Date Col'.padEnd(18) +
      'Historical?'
    );
    console.log('-'.repeat(120));

    for (const r of results) {
      if (!r.exists) {
        console.log(`${r.table.padEnd(42)}NO      ${''.padStart(8)}${''.padStart(8)}${''.padStart(8)}${''.padStart(8)}  —                 table missing`);
        continue;
      }
      console.log(
        `${r.table.padEnd(42)}` +
        `${'YES'.padEnd(8)}` +
        `${String(r.totalRows).padStart(8)}` +
        `${String(r.dealerCounts.N5211 || 0).padStart(8)}` +
        `${String(r.dealerCounts.N6250 || 0).padStart(8)}` +
        `${String(r.dealerCounts.N6828 || 0).padStart(8)}` +
        `  ${(r.dateColumn || '—').padEnd(16)}` +
        `${r.hasHistoricalRange ? 'YES' : 'NO'}`
      );
    }

    console.log('\n' + '='.repeat(120));
    console.log('PER TABLE / PER DEALER DETAIL');
    console.log('='.repeat(120));

    for (const r of results) {
      if (!r.exists) continue;
      console.log(`\n## ${r.table}`);
      console.log(`Date column: ${r.dateColumn || 'none'} | Total rows: ${r.totalRows}`);
      for (const d of r.dealers) {
        console.log(
          `  ${d.dealer}: ${d.rows} rows | ${d.minDate ?? '—'} → ${d.maxDate ?? '—'} | ` +
          `months ${d.monthsPresent}/${d.monthsExpected} | status=${d.status}`
        );
        if (d.missingMonths.length && d.rows > 0) {
          console.log(`    missing months (${d.missingMonths.length}): ${formatMissing(d.missingMonths)}`);
        }
      }
    }

    console.log('\n' + '='.repeat(120));
    console.log('OVERALL FINDINGS');
    console.log('='.repeat(120));

    const existing = results.filter(r => r.exists);
    const missingTables = results.filter(r => !r.exists);
    const historicalTables = existing.filter(r => r.hasHistoricalRange);
    const snapshotOnly = existing.filter(r => !r.hasHistoricalRange && r.totalRows > 0);
    const emptyTables = existing.filter(r => r.totalRows === 0);

    console.log(`\nTables in scope: ${TABLES.length}`);
    console.log(`Exist in DB: ${existing.length} | Missing from DB: ${missingTables.length}`);
    console.log(`With historical span (2021→today, any dealer): ${historicalTables.length}`);
    console.log(`Snapshot/current-only or no date column: ${snapshotOnly.length}`);
    console.log(`Empty: ${emptyTables.length}`);

    if (missingTables.length) {
      console.log('\nMissing tables:');
      for (const t of missingTables) console.log(`  - ${t.table}`);
    }

    console.log('\nDealer completeness (all existing tables with rows):');
    for (const dealer of DEALERS) {
      let tablesWithData = 0;
      let tablesFullHistorical = 0;
      let tablesPartial = 0;
      let tablesMissing = 0;
      let tablesCurrentOnly = 0;

      for (const r of existing) {
        const d = r.dealers.find(x => x.dealer === dealer);
        if (!d || d.status === 'no_data') {
          tablesMissing += 1;
          continue;
        }
        tablesWithData += 1;
        if (d.status === 'full_historical') tablesFullHistorical += 1;
        else if (d.status === 'partial_range' || d.status === 'sparse') tablesPartial += 1;
        else if (d.status === 'current_month_only') tablesCurrentOnly += 1;
      }

      console.log(
        `  ${dealer}: data in ${tablesWithData}/${existing.length} tables | ` +
        `full=${tablesFullHistorical} partial=${tablesPartial} current-only=${tablesCurrentOnly} missing=${tablesMissing}`
      );
    }

    console.log('\nTables needing backfill (not full 2021→today for at least one dealer):');
    for (const r of existing) {
      const problemDealers = r.dealers.filter(d =>
        d.status === 'no_data' ||
        d.status === 'current_month_only' ||
        d.status === 'partial_range' ||
        d.status === 'sparse' ||
        d.status === 'no_date_column'
      );
      if (problemDealers.length) {
        console.log(`  ${r.table}:`);
        for (const d of problemDealers) {
          console.log(`    ${d.dealer} — ${d.status}${d.missingMonths.length ? ` (${d.missingMonths.length} missing months)` : ''}`);
        }
      }
    }
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
