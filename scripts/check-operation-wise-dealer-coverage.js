import { config } from '../src/config.js';
import { withPostgresClient } from '../src/supabase/postgres.js';

const TARGET_START = '2021-01-01';
const TARGET_END = '2026-06-01';
const DEALERS = config.amPlatinumDealerCodes?.length
  ? config.amPlatinumDealerCodes
  : ['N5211', 'N6250', 'N6828'];
const TABLE = 'am_platinum_operation_wise_analysis_report';
const REPORT_TYPES = ['Operation', 'Part'];

function expectedMonths(start, end) {
  const months = [];
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  let year = startYear;
  let month = startMonth;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

async function main() {
  const expected = expectedMonths(TARGET_START, TARGET_END);

  await withPostgresClient(async client => {
    const exists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [TABLE]
    );

    if (!exists.rows[0]?.exists) {
      console.log(`Table missing: ${TABLE}`);
      return;
    }

    console.log('\nOperation Wise coverage check');
    console.log(`Table: ${TABLE}`);
    console.log(`Target range: ${TARGET_START} to ${TARGET_END}`);
    console.log(`Expected months: ${expected.length} (${expected[0]} .. ${expected.at(-1)})`);
    console.log(`Dealers: ${DEALERS.join(', ')}\n`);

    const allDealers = await client.query(`
      SELECT source_dealer_code AS dealer, COUNT(*)::int AS cnt
      FROM public.${TABLE}
      GROUP BY 1
      ORDER BY 1
    `);

    console.log('All dealers in table:');
    for (const row of allDealers.rows) {
      console.log(`  ${row.dealer} - ${row.cnt} rows`);
    }

    const n6250 = await client.query(`
      SELECT report_type,
             COUNT(*)::int AS cnt,
             MIN(report_period_start)::date AS min_start,
             MAX(COALESCE(report_period_end, report_period_start))::date AS max_end,
             COUNT(DISTINCT report_month)::int AS months
      FROM public.${TABLE}
      WHERE upper(trim(source_dealer_code::text)) = 'N6250'
      GROUP BY report_type
      ORDER BY report_type
    `);
    if (n6250.rows.length) {
      console.log('\nN6250 (Rajouri, canonical dealer code):');
      for (const row of n6250.rows) {
        console.log(`  ${row.report_type}: ${row.cnt} rows, ${row.min_start} to ${row.max_end}, ${row.months} months`);
      }
    }
    console.log('');

    const overall = {};

    for (const dealerCode of DEALERS) {
      console.log('='.repeat(60));
      console.log(`Dealer: ${dealerCode}`);
      let dealerComplete = true;
      overall[dealerCode] = {};

      for (const reportType of REPORT_TYPES) {
        const summary = await client.query(
          `
            SELECT COUNT(*)::int AS row_count,
                   MIN(report_period_start)::date AS min_start,
                   MAX(COALESCE(report_period_end, report_period_start))::date AS max_end,
                   COUNT(DISTINCT report_month)::int AS distinct_months
            FROM public.${TABLE}
            WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))
              AND report_type = $2
              AND report_period_start >= $3::date
              AND report_period_start <= $4::date
          `,
          [dealerCode, reportType, TARGET_START, TARGET_END]
        );

        const months = await client.query(
          `
            SELECT DISTINCT LEFT(
              COALESCE(
                NULLIF(report_month::text, ''),
                to_char(report_period_start, 'YYYY-MM')
              ),
              7
            ) AS ym
            FROM public.${TABLE}
            WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))
              AND report_type = $2
              AND report_period_start >= $3::date
              AND report_period_start <= $4::date
            ORDER BY 1
          `,
          [dealerCode, reportType, TARGET_START, TARGET_END]
        );

        const present = new Set(months.rows.map(row => row.ym).filter(Boolean));
        const missing = expected.filter(month => !present.has(month));
        const row = summary.rows[0];
        const complete = missing.length === 0 && Number(row.row_count) > 0;

        if (!complete) {
          dealerComplete = false;
        }

        overall[dealerCode][reportType] = {
          complete,
          rowCount: Number(row.row_count ?? 0),
          minStart: row.min_start,
          maxEnd: row.max_end,
          distinctMonths: Number(row.distinct_months ?? 0),
          missingMonths: missing
        };

        console.log(`  ${reportType}:`);
        console.log(`    rows in range: ${row.row_count}`);
        console.log(`    period: ${row.min_start} to ${row.max_end}`);
        console.log(`    distinct months: ${row.distinct_months} / ${expected.length}`);
        console.log(`    status: ${complete ? 'COMPLETE' : 'INCOMPLETE'}`);

        if (missing.length) {
          const preview = missing.slice(0, 15).join(', ');
          console.log(`    missing months (${missing.length}): ${preview}${missing.length > 15 ? ' ...' : ''}`);
        }
      }

      console.log(`  Overall: ${dealerComplete ? 'COMPLETE for both types' : 'INCOMPLETE'}\n`);
    }

    console.log('='.repeat(60));
    console.log('Summary');
    for (const dealerCode of DEALERS) {
      const op = overall[dealerCode].Operation;
      const part = overall[dealerCode].Part;
      const allComplete = op.complete && part.complete;
      console.log(
        `${dealerCode}: ${allComplete ? 'YES - full coverage' : 'NO - gaps remain'} ` +
        `(Operation ${op.distinctMonths}/${expected.length}, Part ${part.distinctMonths}/${expected.length})`
      );
    }

    const allDealersComplete = DEALERS.every(dealerCode =>
      overall[dealerCode].Operation.complete && overall[dealerCode].Part.complete
    );
    console.log(`\nAll target dealers complete through ${TARGET_END}: ${allDealersComplete ? 'YES' : 'NO'}`);

    const rajouriCutoff = config.amPlatinumHistoricalCutoffDate || '2024-03-01';
    const n6250Expected = expectedMonths(rajouriCutoff, TARGET_END);
    console.log('\n' + '='.repeat(60));
    console.log(`Rajouri MIS1988 window (stored as N6250, fetched via MIS1988/ACTIVE from ${rajouriCutoff}):`);
    for (const reportType of REPORT_TYPES) {
      const months = await client.query(
        `
          SELECT DISTINCT LEFT(
            COALESCE(
              NULLIF(report_month::text, ''),
              to_char(report_period_start, 'YYYY-MM')
            ),
            7
          ) AS ym
          FROM public.${TABLE}
          WHERE upper(trim(source_dealer_code::text)) = 'N6250'
            AND report_type = $1
            AND report_period_start >= $2::date
            AND report_period_start <= $3::date
          ORDER BY 1
        `,
        [reportType, rajouriCutoff, TARGET_END]
      );
      const present = new Set(months.rows.map(row => row.ym).filter(Boolean));
      const missing = n6250Expected.filter(month => !present.has(month));
      console.log(
        `  ${reportType}: ${present.size}/${n6250Expected.length} months - ${missing.length ? 'INCOMPLETE' : 'COMPLETE'}`
      );
      if (missing.length) {
        console.log(`    missing: ${missing.join(', ')}`);
      }
    }
  });
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
