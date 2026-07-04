import 'dotenv/config';
import { withPostgresClient } from '../src/supabase/postgres.js';

const DEALERS = ['N5211', 'N6250', 'N6828'];
const START = '2021-01-01';
const END = new Date().toISOString().slice(0, 10);

const TABLES = [
  {
    table: 'am_platinum_repair_order_list',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'r_o_date'
  },
  {
    table: 'am_platinum_ro_billing_report',
    dealerColumn: 'dealer_code',
    altDealerColumn: 'source_dealer_code',
    dateColumn: 'bill_date'
  },
  {
    table: 'am_platinum_call_center_complaints',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'complaint_date'
  },
  {
    table: 'am_platinum_customer_complaint_list',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'complaint_date'
  },
  {
    table: 'am_platinum_demo_car_list',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'hmi_invoice_date'
  },
  {
    table: 'am_platinum_service_appointment',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'b_t_date_time'
  },
  {
    table: 'am_platinum_trust_package',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'reg_date'
  },
  {
    table: 'am_platinum_psf_yearly',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'r_o_date'
  },
  {
    table: 'am_platinum_ew_report',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'report_month'
  },
  {
    table: 'am_platinum_adv_wise_lubricants_vas',
    dealerColumn: 'source_dealer_code',
    dateColumn: null,
    note: 'No business date column; snapshot report'
  },
  {
    table: 'am_platinum_operation_wise_analysis_report',
    dealerColumn: 'source_dealer_code',
    dateColumn: 'report_month'
  }
];

const MISSING_TABLES = [
  'am_platinum_open_ro_yearly',
  'am_platinum_demo_job_cards',
  'am_platinum_mcp_report'
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

async function dealerStats(client, { table, dealerColumn, altDealerColumn, dateColumn, note }, dealer) {
  const dealerExpr = altDealerColumn
    ? `COALESCE(NULLIF("${dealerColumn}", ''), NULLIF("${altDealerColumn}", ''))`
    : `"${dealerColumn}"`;

  const countRes = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM public."${table}" WHERE ${dealerExpr} = $1`,
    [dealer]
  );
  const rows = countRes.rows[0].cnt;

  if (!rows) {
    return { dealer, rows: 0, minDate: null, maxDate: null, monthsPresent: 0, missingMonths: ALL_MONTHS, status: 'no_data' };
  }

  if (!dateColumn) {
    return {
      dealer,
      rows,
      minDate: null,
      maxDate: null,
      monthsPresent: null,
      missingMonths: [],
      status: 'snapshot_no_business_date',
      note
    };
  }

  const rangeRes = await client.query(
    `SELECT MIN("${dateColumn}")::date AS min_date, MAX("${dateColumn}")::date AS max_date,
            COUNT(*) FILTER (WHERE "${dateColumn}" IS NOT NULL)::int AS dated_rows
     FROM public."${table}" WHERE ${dealerExpr} = $1`,
    [dealer]
  );

  const minDate = rangeRes.rows[0].min_date;
  const maxDate = rangeRes.rows[0].max_date;
  const datedRows = rangeRes.rows[0].dated_rows;

  if (!datedRows) {
    return {
      dealer,
      rows,
      minDate: null,
      maxDate: null,
      monthsPresent: 0,
      missingMonths: ALL_MONTHS,
      status: 'rows_but_null_dates'
    };
  }

  const monthRes = await client.query(
    `SELECT to_char(date_trunc('month', "${dateColumn}"::timestamp), 'YYYY-MM') AS month_key, COUNT(*)::int AS cnt
     FROM public."${table}"
     WHERE ${dealerExpr} = $1 AND "${dateColumn}" IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    [dealer]
  );

  const present = new Set(monthRes.rows.map(r => r.month_key));
  const missingMonths = ALL_MONTHS.filter(m => !present.has(m));

  let status = 'full_historical';
  if (minDate > new Date(START) || maxDate < new Date(END)) status = 'partial_range';
  if (missingMonths.length > ALL_MONTHS.length * 0.5) status = 'sparse';
  if (minDate >= new Date('2026-06-01') && maxDate <= new Date(END)) status = 'current_month_only';

  return {
    dealer,
    rows,
    minDate: minDate?.toISOString?.().slice(0, 10) ?? String(minDate),
    maxDate: maxDate?.toISOString?.().slice(0, 10) ?? String(maxDate),
    monthsPresent: present.size,
    monthsExpected: ALL_MONTHS.length,
    missingMonths,
    status
  };
}

function summarizeMissing(missing, limit = 8) {
  if (!missing?.length) return 'none';
  if (missing.length <= limit) return missing.join(', ');
  return `${missing.slice(0, limit).join(', ')} (+${missing.length - limit} more)`;
}

await withPostgresClient(async (client) => {
  console.log('\nAM PLATINUM — CORRECTED HISTORICAL ANALYSIS (2021-01-01 → today)');
  console.log(`Today: ${END} | Expected months: ${ALL_MONTHS.length}\n`);

  const results = [];

  for (const entry of TABLES) {
    if (!(await tableExists(client, entry.table))) {
      results.push({ ...entry, exists: false });
      continue;
    }

    const dealers = [];
    for (const dealer of DEALERS) {
      dealers.push(await dealerStats(client, entry, dealer));
    }

    const totalRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM public."${entry.table}"`);
    results.push({ ...entry, exists: true, totalRows: totalRes.rows[0].cnt, dealers });
  }

  console.log('='.repeat(130));
  console.log(
    `${'Table'.padEnd(42)}${'Rows'.padStart(7)}  ` +
    `${'N5211'.padStart(7)}${'N6250'.padStart(7)}${'N6828'.padStart(7)}  ` +
    `${'Date Col'.padEnd(16)}Coverage`
  );
  console.log('-'.repeat(130));

  for (const r of results) {
    if (!r.exists) {
      console.log(`${r.table.padEnd(42)}${'—'.padStart(7)}  table missing in DB`);
      continue;
    }
    const counts = Object.fromEntries(r.dealers.map(d => [d.dealer, d.rows]));
    const hasHist = r.dealers.some(d =>
      ['full_historical', 'partial_range', 'sparse'].includes(d.status)
    );
    console.log(
      `${r.table.padEnd(42)}${String(r.totalRows).padStart(7)}  ` +
      `${String(counts.N5211 || 0).padStart(7)}${String(counts.N6250 || 0).padStart(7)}${String(counts.N6828 || 0).padStart(7)}  ` +
      `${(r.dateColumn || 'none').padEnd(16)}${hasHist ? 'historical' : 'no/partial hist'}`
    );
  }

  for (const t of MISSING_TABLES) {
    const exists = await tableExists(client, t);
    if (!exists) console.log(`${t.padEnd(42)}${'—'.padStart(7)}  table missing in DB`);
  }

  console.log('\n' + '='.repeat(130));
  console.log('DETAILED BY TABLE & DEALER');
  console.log('='.repeat(130));

  for (const r of results.filter(x => x.exists)) {
    console.log(`\n### ${r.table}`);
    console.log(`Total rows: ${r.totalRows} | Dealer filter: ${r.dealerColumn}${r.altDealerColumn ? ` (+ ${r.altDealerColumn})` : ''} | Date: ${r.dateColumn || 'none'}`);
    if (r.note) console.log(`Note: ${r.note}`);
    for (const d of r.dealers) {
      const range = d.minDate ? `${d.minDate} → ${d.maxDate}` : '—';
      const months = d.monthsPresent == null ? 'n/a' : `${d.monthsPresent}/${d.monthsExpected ?? ALL_MONTHS.length}`;
      console.log(`  ${d.dealer}: ${d.rows} rows | ${range} | months ${months} | ${d.status}`);
      if (d.missingMonths?.length && d.rows > 0 && d.status !== 'snapshot_no_business_date') {
        console.log(`    gaps: ${summarizeMissing(d.missingMonths)}`);
      }
    }
  }

  console.log('\n' + '='.repeat(130));
  console.log('EXECUTIVE SUMMARY');
  console.log('='.repeat(130));

  console.log('\n1) DEALER N6250 (Rajouri)');
  const n6250Present = results.filter(r => r.exists && (r.dealers.find(d => d.dealer === 'N6250')?.rows || 0) > 0);
  if (n6250Present.length === 0) {
    console.log('   NO rows for N6250 in any table when filtered by source_dealer_code.');
    const billing = results.find(r => r.table === 'am_platinum_ro_billing_report');
    const billing6250 = billing?.dealers.find(d => d.dealer === 'N6250');
    if (billing6250?.rows) {
      console.log(`   Exception: ro_billing has ${billing6250.rows} rows via dealer_code column.`);
    }
  } else {
    console.log(`   Has data in ${n6250Present.length} table(s): ${n6250Present.map(r => r.table).join(', ')}`);
  }

  const legacy6824 = await client.query(`
    SELECT 'am_platinum_operation_wise_analysis_report' AS table_name, COUNT(*)::int AS cnt
    FROM public.am_platinum_operation_wise_analysis_report
    WHERE upper(trim(source_dealer_code::text)) = 'N6824'
  `);
  const legacyCount = Number(legacy6824.rows[0]?.cnt ?? 0);
  if (legacyCount > 0) {
    console.log(`   Legacy N6824 rows still present (run migration): ${legacyCount} in operation_wise`);
  }

  console.log('\n2) TABLES WITH TRUE HISTORICAL COVERAGE (2021–2026, dated business column)');
  for (const r of results.filter(x => x.exists && x.dateColumn)) {
    const good = r.dealers.filter(d => ['full_historical', 'partial_range'].includes(d.status) && d.monthsPresent >= 60);
    if (good.length) {
      console.log(`   ${r.table}: ${good.map(d => `${d.dealer}(${d.monthsPresent}mo)`).join(', ')}`);
    }
  }

  console.log('\n3) TABLES WITHOUT HISTORICAL DATE TRACKING');
  for (const r of results.filter(x => x.exists && (!x.dateColumn || x.dealers.every(d => d.status === 'snapshot_no_business_date' || d.status === 'rows_but_null_dates')))) {
    console.log(`   ${r.table}`);
  }

  console.log('\n4) STALE / UNEXPECTED DEALER CODE DATA (not N5211, N6250, N6828)');
  for (const r of results.filter(x => x.exists)) {
    const col = r.dealerColumn;
    const extra = await client.query(
      `SELECT "${col}" AS code, COUNT(*)::int AS cnt FROM public."${r.table}"
       WHERE "${col}" IS NOT NULL AND upper(trim("${col}"::text)) NOT IN ('N5211','N6250','N6828','ACTIVE')
       GROUP BY 1 ORDER BY cnt DESC LIMIT 5`
    );
    if (extra.rows.length) {
      console.log(`   ${r.table}: ${extra.rows.map(x => `${x.code}=${x.cnt}`).join(', ')}`);
    }
  }
});
