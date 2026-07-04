import { config } from '../src/config.js';
import { withPostgresClient } from '../src/supabase/postgres.js';
import { getCalendarMonthRanges, parseIsoLocalDate, toIsoDate } from '../src/utils/date-range.js';

const RAJOURI_FETCH = 'N6824';
const start = config.hmilWarrantyHistoricalStartDate || '2025-01-01';
const end = toIsoDate(new Date());
const expectedMonths = getCalendarMonthRanges(
  parseIsoLocalDate(start),
  parseIsoLocalDate(end)
).map(range => range.startIso.slice(0, 7));

const REPORTS = [
  { key: 'list', table: 'hyundai_warranty_claim_list', dateCol: 'claim_date', label: 'Claim List' },
  { key: 'ytp', table: 'hyundai_warranty_claim_ytp', dateCol: 'r_o_date', label: 'Claim YTP' }
];

function buildAssignments() {
  return [
    {
      login: String(config.hmilUserId || 'sahiltech').trim(),
      group: 'Hyundai primary',
      dealers: config.hmilPrimaryDealerCodes
    },
    {
      login: String(config.hmilSecondaryUserId || 'MIS5216').trim(),
      group: 'Hyundai secondary',
      dealers: config.hmilWarrantySecondaryDealerCodes
    },
    {
      login: String(config.amPlatinumUserId || 'MIS1988').trim(),
      group: 'Platinum current (cron)',
      dealers: config.amPlatinumDealerCodes,
      fetchAs: {}
    },
    {
      login: String(config.amPlatinumHistoricalUserId || 'MIS12345').trim(),
      group: 'Platinum historical (full run only)',
      dealers: config.amPlatinumDealerCodes,
      fetchAs: { N6250: RAJOURI_FETCH }
    }
  ];
}

function classifyStatus(reportKey, rowCount, monthsPresent) {
  if (rowCount === 0) {
    return 'MISSING';
  }

  if (reportKey === 'list' && monthsPresent < expectedMonths.length) {
    return 'PARTIAL';
  }

  if (reportKey === 'ytp' && rowCount < 5) {
    return 'PARTIAL';
  }

  return 'OK';
}

function fetchLabel(dealer, fetchAs) {
  return fetchAs === dealer ? dealer : `${fetchAs}->${dealer}`;
}

async function queryReportCounts(client, { table, dateCol, dealer, login }) {
  const summary = await client.query(
    `SELECT COUNT(*)::int AS row_count,
            MIN(${dateCol})::date AS min_d,
            MAX(${dateCol})::date AS max_d
     FROM public.${table}
     WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))
       AND lower(trim(source_login_id::text)) = lower(trim($2::text))`,
    [dealer, login]
  );

  const rowCount = Number(summary.rows[0]?.row_count ?? 0);
  let monthsPresent = 0;

  if (rowCount > 0 && dateCol === 'claim_date') {
    const months = await client.query(
      `SELECT DISTINCT to_char(${dateCol}::date, 'YYYY-MM') AS ym
       FROM public.${table}
       WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))
         AND lower(trim(source_login_id::text)) = lower(trim($2::text))
         AND ${dateCol} IS NOT NULL`,
      [dealer, login]
    );
    monthsPresent = months.rows.filter(row => expectedMonths.includes(row.ym)).length;
  }

  return {
    rowCount,
    minDate: summary.rows[0]?.min_d,
    maxDate: summary.rows[0]?.max_d,
    monthsPresent
  };
}

export async function analyzeWarrantyCoverageByLogin() {
  const assignments = buildAssignments();
  const gaps = [];
  let ok = 0;
  let partial = 0;
  let missing = 0;

  console.log('');
  console.log('Warranty coverage audit — 4 login IDs × assigned dealers × 2 reports');
  console.log(`Expected Claim List range: ${start} → ${end} (${expectedMonths.length} months)`);
  console.log('Note: daily warranty scheduling currently includes sahiltech, MIS5216, MIS1988, and MIS12345.');
  console.log('');

  await withPostgresClient(async client => {
    for (const assignment of assignments) {
      console.log('='.repeat(98));
      console.log(`${assignment.group} | login: ${assignment.login}`);
      console.log('='.repeat(98));
      console.log('Dealer | Portal as | Report      | Rows   | Months | Status');
      console.log('-'.repeat(98));

      for (const dealer of assignment.dealers) {
        const fetchAs = assignment.fetchAs?.[dealer] || dealer;

        for (const report of REPORTS) {
          const stats = await queryReportCounts(client, {
            table: report.table,
            dateCol: report.dateCol,
            dealer,
            login: assignment.login
          });
          const status = classifyStatus(report.key, stats.rowCount, stats.monthsPresent);

          if (status === 'MISSING') missing += 1;
          else if (status === 'PARTIAL') partial += 1;
          else ok += 1;

          const monthCol = report.key === 'list'
            ? `${stats.monthsPresent}/${expectedMonths.length}`
            : 'n/a';

          console.log(
            `${dealer.padEnd(6)} | ${fetchLabel(dealer, fetchAs).padEnd(9)} | ${report.label.padEnd(11)} | ` +
            `${String(stats.rowCount).padStart(6)} | ${monthCol.padStart(6)} | ${status}`
          );

          if (status !== 'OK') {
            gaps.push({
              login: assignment.login,
              group: assignment.group,
              dealer,
              fetchAs,
              report: report.label,
              status,
              rowCount: stats.rowCount,
              monthsPresent: stats.monthsPresent
            });
          }
        }

        console.log('');
      }
    }
  });

  const total = ok + partial + missing;
  console.log('='.repeat(98));
  console.log(`SUMMARY: OK=${ok} | PARTIAL=${partial} | MISSING=${missing} (out of ${total} login/dealer/report cells)`);
  console.log('='.repeat(98));
  console.log('');

  if (gaps.length) {
    console.log(`Gaps (${gaps.length}):`);
    for (const gap of gaps) {
      const fetchNote = gap.fetchAs !== gap.dealer ? ` (portal fetch ${gap.fetchAs})` : '';
      const detail = gap.report === 'Claim List' && gap.rowCount
        ? ` — ${gap.monthsPresent}/${expectedMonths.length} months`
        : gap.rowCount
          ? ` — ${gap.rowCount} rows`
          : '';
      console.log(`  ${gap.login} | ${gap.dealer}${fetchNote} | ${gap.report} | ${gap.status}${detail}`);
    }
  } else {
    console.log('All login/dealer/report combinations look complete.');
  }

  console.log('');
  console.log('Suggested runs:');
  console.log('  MIS5216 gap:     npm run hmil:warranty:secondary-all');
  console.log('  sahiltech gap:   npm run hmil:warranty:resume  (or per-dealer backfill)');
  console.log('  Platinum gap:    npm run hmil:warranty:full-all or hmil:warranty:resume');
  console.log('');

  return { ok, partial, missing, total, gaps };
}

const isMain = process.argv[1]?.includes('analyze-warranty-coverage-by-login.js');
if (isMain) {
  analyzeWarrantyCoverageByLogin().catch(error => {
    console.error('Warranty coverage analysis failed:', error);
    process.exitCode = 1;
  });
}
