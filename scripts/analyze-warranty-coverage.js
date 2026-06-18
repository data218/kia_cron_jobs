import fs from 'node:fs/promises';
import path from 'node:path';
import { createWarrantyScheduledAccounts } from '../src/accounts/hmil-warranty-accounts.js';
import { config } from '../src/config.js';
import { getWarrantyDealerCodesForAccount } from '../src/cron/hmil-warranty-scheduler.js';
import { withPostgresClient } from '../src/supabase/postgres.js';
import { getCalendarMonthRanges, parseIsoLocalDate } from '../src/utils/date-range.js';

const CLAIM_LIST_TABLE = 'hyundai_warranty_claim_list';
const CLAIM_YTP_TABLE = 'hyundai_warranty_claim_ytp';

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeDealer(value) {
  return String(value || '').trim().toUpperCase();
}

function buildExpectedPlan() {
  const startDate = parseIsoLocalDate(config.hmilWarrantyHistoricalStartDate || '2025-01-01');
  const endDate = new Date();
  const expectedMonths = getCalendarMonthRanges(startDate, endDate).map(range => range.startIso.slice(0, 7));

  const entries = [];
  for (const account of createWarrantyScheduledAccounts()) {
    for (const dealerCode of getWarrantyDealerCodesForAccount(account)) {
      entries.push({
        login: account.userId,
        accountId: account.id,
        dealerCode: normalizeDealer(dealerCode)
      });
    }
  }

  return { startDate, endDate, expectedMonths, entries };
}

async function loadCoverage(client) {
  const claimListRows = await client.query(`
    select lower(trim(source_login_id::text)) as login,
           upper(trim(source_dealer_code::text)) as dealer,
           to_char(claim_date::date, 'YYYY-MM') as ym,
           count(*)::int as cnt
    from public.${CLAIM_LIST_TABLE}
    where claim_date is not null
    group by 1, 2, 3
    order by 1, 2, 3
  `);

  const claimYtpRows = await client.query(`
    select lower(trim(source_login_id::text)) as login,
           upper(trim(source_dealer_code::text)) as dealer,
           count(*)::int as cnt
    from public.${CLAIM_YTP_TABLE}
    group by 1, 2
    order by 1, 2
  `);

  const claimListByKey = new Map();
  for (const row of claimListRows.rows) {
    const key = `${row.login}|${row.dealer}`;
    if (!claimListByKey.has(key)) {
      claimListByKey.set(key, new Map());
    }
    claimListByKey.get(key).set(row.ym, row.cnt);
  }

  const claimYtpByKey = new Map(
    claimYtpRows.rows.map(row => [`${row.login}|${row.dealer}`, row.cnt])
  );

  return { claimListByKey, claimYtpByKey };
}

export async function analyzeWarrantyCoverage() {
  const plan = buildExpectedPlan();
  const coverage = await withPostgresClient(loadCoverage);

  const populated = [];
  const claimListGaps = [];
  const claimYtpGaps = [];

  for (const entry of plan.entries) {
    const key = `${normalizeLogin(entry.login)}|${entry.dealerCode}`;
    const monthMap = coverage.claimListByKey.get(key) ?? new Map();
    const populatedMonths = [...monthMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ym, cnt]) => ({ ym, cnt }));

    if (populatedMonths.length) {
      populated.push({
        report: 'claim-list',
        login: entry.login,
        dealerCode: entry.dealerCode,
        months: populatedMonths
      });
    }

    const missingMonths = plan.expectedMonths.filter(ym => !monthMap.has(ym));
    if (missingMonths.length) {
      claimListGaps.push({
        reportId: 'hyundai-warranty-claim-list',
        login: entry.login,
        accountId: entry.accountId,
        dealerCode: entry.dealerCode,
        missingMonths
      });
    }

    const ytpCount = coverage.claimYtpByKey.get(key) ?? 0;
    if (ytpCount > 0) {
      populated.push({
        report: 'claim-ytp',
        login: entry.login,
        dealerCode: entry.dealerCode,
        rowCount: ytpCount
      });
    } else {
      claimYtpGaps.push({
        reportId: 'hyundai-warranty-claim-ytp',
        login: entry.login,
        accountId: entry.accountId,
        dealerCode: entry.dealerCode
      });
    }
  }

  return {
    rangeStart: config.hmilWarrantyHistoricalStartDate || '2025-01-01',
    rangeEnd: new Date().toISOString().slice(0, 10),
    expectedMonthCount: plan.expectedMonths.length,
    expectedMonths: plan.expectedMonths,
    populated,
    claimListGaps,
    claimYtpGaps,
    accounts: createWarrantyScheduledAccounts().map(account => ({
      login: account.userId,
      accountId: account.id,
      dealers: getWarrantyDealerCodesForAccount(account).map(normalizeDealer)
    }))
  };
}

function printCoverageReport(report) {
  console.log('');
  console.log('Warranty coverage analysis');
  console.log(`Range: ${report.rangeStart} to ${report.rangeEnd} (${report.expectedMonthCount} calendar months)`);
  console.log('');

  console.log('Configured accounts/dealers:');
  for (const account of report.accounts) {
    console.log(`  ${account.login}: ${account.dealers.join(', ')}`);
  }
  console.log('');

  console.log('=== Claim List — months WITH data ===');
  const listPopulated = report.populated.filter(item => item.report === 'claim-list');
  if (!listPopulated.length) {
    console.log('  (none)');
  } else {
    for (const item of listPopulated) {
      const summary = item.months.map(month => `${month.ym} (${month.cnt})`).join(', ');
      console.log(`  ${item.login} / ${item.dealerCode}: ${summary}`);
    }
  }

  console.log('');
  console.log('=== Claim YTP — dealers WITH data ===');
  const ytpPopulated = report.populated.filter(item => item.report === 'claim-ytp');
  if (!ytpPopulated.length) {
    console.log('  (none)');
  } else {
    for (const item of ytpPopulated) {
      console.log(`  ${item.login} / ${item.dealerCode}: ${item.rowCount} rows`);
    }
  }

  console.log('');
  console.log('=== Claim List GAPS (missing months) ===');
  if (!report.claimListGaps.length) {
    console.log('  All dealers fully covered by month marker.');
  } else {
    for (const gap of report.claimListGaps) {
      console.log(`  ${gap.login} / ${gap.dealerCode}: ${gap.missingMonths.length} months -> ${gap.missingMonths.join(', ')}`);
    }
  }

  console.log('');
  console.log('=== Claim YTP GAPS (no rows saved) ===');
  if (!report.claimYtpGaps.length) {
    console.log('  All dealers have Claim YTP rows.');
  } else {
    for (const gap of report.claimYtpGaps) {
      console.log(`  ${gap.login} / ${gap.dealerCode}`);
    }
  }

  console.log('');
  console.log('Summary');
  console.log(`  Claim List gap slots: ${report.claimListGaps.reduce((sum, gap) => sum + gap.missingMonths.length, 0)}`);
  console.log(`  Claim List dealers with gaps: ${report.claimListGaps.length}`);
  console.log(`  Claim YTP dealers with gaps: ${report.claimYtpGaps.length}`);
  console.log('');
}

export function buildGapBackfillPlan(report) {
  const dealersNeedingClaimList = new Map();
  for (const gap of report.claimListGaps) {
    if (!dealersNeedingClaimList.has(gap.login)) {
      dealersNeedingClaimList.set(gap.login, new Set());
    }
    dealersNeedingClaimList.get(gap.login).add(gap.dealerCode);
  }

  const dealersNeedingYtp = new Map();
  for (const gap of report.claimYtpGaps) {
    if (!dealersNeedingYtp.has(gap.login)) {
      dealersNeedingYtp.set(gap.login, new Set());
    }
    dealersNeedingYtp.get(gap.login).add(gap.dealerCode);
  }

  const accountIds = new Set([
    ...report.claimListGaps.map(gap => gap.accountId),
    ...report.claimYtpGaps.map(gap => gap.accountId)
  ]);

  const reports = [];
  if (report.claimListGaps.length) {
    reports.push('hyundai-warranty-claim-list');
  }
  if (report.claimYtpGaps.length) {
    reports.push('hyundai-warranty-claim-ytp');
  }

  const dealerCodesByAccount = {};
  for (const account of report.accounts) {
    const listDealers = dealersNeedingClaimList.get(account.login) ?? new Set();
    const ytpDealers = dealersNeedingYtp.get(account.login) ?? new Set();
    const combined = new Set([...listDealers, ...ytpDealers]);
    if (combined.size) {
      dealerCodesByAccount[account.login] = [...combined];
    }
  }

  return {
    accountIds: [...accountIds],
    reports,
    dealerCodesByAccount,
    claimListGaps: report.claimListGaps,
    claimYtpGaps: report.claimYtpGaps
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('analyze-warranty-coverage.js');

if (isMain) {
  const report = await analyzeWarrantyCoverage();
  printCoverageReport(report);

  const outPath = path.join(config.logsDir, 'warranty-coverage-gaps.json');
  await fs.mkdir(config.logsDir, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...report,
    backfillPlan: buildGapBackfillPlan(report)
  }, null, 2));
  console.log(`Saved: ${outPath}`);
}
