import { withPostgresClient } from '../src/supabase/postgres.js';
import { config } from '../src/config.js';
import { getCalendarMonthRanges, parseIsoLocalDate, toIsoDate } from '../src/utils/date-range.js';

const expectedStart = config.hmilWarrantyHistoricalStartDate || '2025-01-01';
const today = toIsoDate(new Date());
const expectedMonths = getCalendarMonthRanges(
  parseIsoLocalDate(expectedStart),
  parseIsoLocalDate(today)
).map(r => r.startIso.slice(0, 7));

const hyundaiDealers = [
  ...(config.hmilDealerCodes?.length ? config.hmilDealerCodes : []),
  ...(config.hmilWarrantySecondaryDealerCodes?.length ? config.hmilWarrantySecondaryDealerCodes : [])
];
const platinumDealers = config.amPlatinumDealerCodes?.length
  ? config.amPlatinumDealerCodes
  : ['N5211', 'N6250', 'N6828'];
const allDealers = [...new Set([...hyundaiDealers, ...platinumDealers])];

const specs = [
  {
    table: 'hyundai_warranty_claim_list',
    label: 'Warranty Claim List',
    dateCol: 'claim_date'
  },
  {
    table: 'hyundai_warranty_claim_ytp',
    label: 'Warranty Claim YTP',
    dateCol: 'r_o_date'
  }
];

function fmtDate(value) {
  if (!value) return 'n/a';
  return String(value).slice(0, 10);
}

await withPostgresClient(async client => {
  console.log('\nWarranty Reports Status');
  console.log(`Expected: ${expectedStart} to ${today} (${expectedMonths.length} months)`);
  console.log(`Configured dealers (Hyundai + Platinum): ${allDealers.join(', ')}`);
  console.log('');

  for (const spec of specs) {
    console.log('='.repeat(72));
    console.log(`${spec.label} (${spec.table})`);
    console.log('='.repeat(72));

    const total = await client.query(`SELECT COUNT(*)::int AS c FROM public.${spec.table}`);
    console.log(`Total rows: ${total.rows[0].c}`);

    const byMonth = await client.query(`
      SELECT to_char(${spec.dateCol}::date, 'YYYY-MM') AS ym, COUNT(*)::int AS cnt
      FROM public.${spec.table}
      WHERE ${spec.dateCol} IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `);
    const monthMap = new Map(byMonth.rows.map(r => [r.ym, r.cnt]));

    console.log('\nGlobal month coverage:');
    if (!byMonth.rows.length) {
      console.log('  (no dated rows)');
    } else {
      for (const r of byMonth.rows) {
        const flag = expectedMonths.includes(r.ym) ? '' : ' (outside target)';
        console.log(`  ${r.ym}: ${r.cnt}${flag}`);
      }
      const covered = expectedMonths.filter(ym => (monthMap.get(ym) || 0) > 0);
      const missing = expectedMonths.filter(ym => !monthMap.get(ym));
      console.log(`\n  Months with data: ${covered.length}/${expectedMonths.length}`);
      if (missing.length) {
        console.log(`  Missing months: ${missing.join(', ')}`);
      }
    }

    console.log('\nPer dealer:');
    for (const dealer of allDealers) {
      const summary = await client.query(
        `SELECT COUNT(*)::int AS cnt,
                MIN(${spec.dateCol})::date AS min_d,
                MAX(${spec.dateCol})::date AS max_d
         FROM public.${spec.table}
         WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))`,
        [dealer]
      );
      const row = summary.rows[0];
      const cnt = Number(row?.cnt ?? 0);

      if (cnt === 0) {
        console.log(`  ${dealer}: NO DATA`);
        continue;
      }

      const months = await client.query(
        `SELECT DISTINCT to_char(${spec.dateCol}::date, 'YYYY-MM') AS ym
         FROM public.${spec.table}
         WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))
           AND ${spec.dateCol} IS NOT NULL
         ORDER BY 1`,
        [dealer]
      );
      const present = new Set(months.rows.map(r => r.ym));
      const missingForDealer = expectedMonths.filter(ym => !present.has(ym));
      const status = missingForDealer.length === 0 ? 'COMPLETE' : `INCOMPLETE (${present.size}/${expectedMonths.length} months)`;

      console.log(`  ${dealer}: ${cnt} rows | ${status}`);
      console.log(`    Range: ${fmtDate(row.min_d)} -> ${fmtDate(row.max_d)}`);
      if (missingForDealer.length && missingForDealer.length <= 6) {
        console.log(`    Missing: ${missingForDealer.join(', ')}`);
      } else if (missingForDealer.length) {
        console.log(`    Missing: ${missingForDealer.slice(0, 3).join(', ')} ... +${missingForDealer.length - 3} more`);
      }
    }

    const byLogin = await client.query(`
      SELECT source_login_id, COUNT(*)::int AS cnt,
             MIN(${spec.dateCol})::date AS min_d, MAX(${spec.dateCol})::date AS max_d
      FROM public.${spec.table}
      GROUP BY 1 ORDER BY 1
    `);
    console.log('\nBy login:');
    for (const r of byLogin.rows) {
      console.log(`  ${r.source_login_id || '(null)'}: ${r.cnt} rows (${fmtDate(r.min_d)} -> ${fmtDate(r.max_d)})`);
    }
    console.log('');
  }
});
