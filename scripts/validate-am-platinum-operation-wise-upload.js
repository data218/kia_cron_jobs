import 'dotenv/config';
import {
  defaultDealerCodes,
  getComparableLyStatus,
  getCurrentYearToDateRange,
  getLastYearComparableRange,
  isPeriodComparableToWindow,
  listPeriodsForDealer,
  OPERATION_WISE_TABLE,
  queryVasPeriodSummary,
  VAS_PERIOD_SUMMARY_VIEW
} from '../src/am-platinum/comparable-period.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';

const VAS_PATTERN = /(vas|value[\s-]*added|coating|enrichment|lubrication|throttle|evaporator|underbody|paint protection|interior|exterior)/i;

function parseArgs(argv) {
  const options = {
    dealers: defaultDealerCodes(),
    cyStart: null,
    cyEnd: null,
    refreshMv: false
  };

  for (const arg of argv) {
    if (arg.startsWith('--dealer=')) {
      options.dealers = [arg.slice('--dealer='.length).trim().toUpperCase()];
    } else if (arg.startsWith('--dealers=')) {
      options.dealers = arg.slice('--dealers='.length).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    } else if (arg.startsWith('--cy-start=')) {
      options.cyStart = arg.slice('--cy-start='.length).trim();
    } else if (arg.startsWith('--cy-end=')) {
      options.cyEnd = arg.slice('--cy-end='.length).trim();
    } else if (arg === '--refresh-mv') {
      options.refreshMv = true;
    }
  }

  const cyRange = getCurrentYearToDateRange();
  options.cyStart = options.cyStart || cyRange.startIso;
  options.cyEnd = options.cyEnd || cyRange.endIso;

  return options;
}

async function tableColumns(client) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [OPERATION_WISE_TABLE]
  );
  return new Set(result.rows.map(row => row.column_name));
}

async function validateRequiredColumns(client, dealerCode, columns) {
  const issues = [];
  const required = ['source_dealer_code', 'report_period_start', 'report_period_end', 'report_type', 'total_amt'];

  for (const column of required) {
    if (!columns.has(column)) {
      issues.push(`missing table column: ${column}`);
    }
  }

  if (issues.length) {
    return { pass: false, issues };
  }

  const invalidDealer = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM public.${quoteIdentifier(OPERATION_WISE_TABLE)}
     WHERE UPPER(TRIM(source_dealer_code::text)) = UPPER(TRIM($1::text))
       AND (
         source_dealer_code IS NULL
         OR TRIM(source_dealer_code::text) = ''
         OR UPPER(TRIM(source_dealer_code::text)) IN ('ACTIVE', 'CURRENT', 'DEFAULT')
       )`,
    [dealerCode]
  );

  if (Number(invalidDealer.rows[0]?.cnt ?? 0) > 0) {
    issues.push('rows with blank/ACTIVE source_dealer_code');
  }

  const missingType = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM public.${quoteIdentifier(OPERATION_WISE_TABLE)}
     WHERE UPPER(TRIM(source_dealer_code::text)) = UPPER(TRIM($1::text))
       AND LOWER(TRIM(report_type::text)) NOT IN ('operation', 'part')`,
    [dealerCode]
  );

  if (Number(missingType.rows[0]?.cnt ?? 0) > 0) {
    issues.push('rows with invalid report_type (must be operation or part)');
  }

  const missingIdentity = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM public.${quoteIdentifier(OPERATION_WISE_TABLE)}
     WHERE UPPER(TRIM(source_dealer_code::text)) = UPPER(TRIM($1::text))
       AND COALESCE(NULLIF(TRIM(op_part_code::text), ''), NULLIF(TRIM(op_part_desc::text), '')) IS NULL`,
    [dealerCode]
  );

  if (Number(missingIdentity.rows[0]?.cnt ?? 0) > 0) {
    issues.push('rows missing both op_part_code and op_part_desc');
  }

  return {
    pass: issues.length === 0,
    issues
  };
}

async function validateCyPeriod(client, dealerCode, cyStart, cyEnd) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS row_count
     FROM public.${quoteIdentifier(OPERATION_WISE_TABLE)}
     WHERE UPPER(TRIM(source_dealer_code::text)) = UPPER(TRIM($1::text))
       AND report_period_start = $2::date
       AND report_period_end = $3::date`,
    [dealerCode, cyStart, cyEnd]
  );

  return Number(result.rows[0]?.row_count ?? 0);
}

async function validateVasRows(client, dealerCode, periodStart, periodEnd) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS vas_rows,
            COALESCE(SUM(total_amt), 0)::numeric AS vas_amount
     FROM public.${quoteIdentifier(OPERATION_WISE_TABLE)}
     WHERE UPPER(TRIM(source_dealer_code::text)) = UPPER(TRIM($1::text))
       AND report_period_start = $2::date
       AND report_period_end = $3::date
       AND (
         COALESCE(op_part_code, '') ~* $4
         OR COALESCE(op_part_desc, '') ~* $4
       )`,
    [dealerCode, periodStart, periodEnd, VAS_PATTERN.source]
  );

  return {
    vasRows: Number(result.rows[0]?.vas_rows ?? 0),
    vasAmount: Number(result.rows[0]?.vas_amount ?? 0)
  };
}

export async function validateAmPlatinumOperationWiseUpload(options = {}) {
  const parsed = typeof options.dealers === 'undefined'
    ? parseArgs(process.argv.slice(2))
    : {
        dealers: options.dealers,
        cyStart: options.cyStart || getCurrentYearToDateRange().startIso,
        cyEnd: options.cyEnd || getCurrentYearToDateRange().endIso,
        refreshMv: Boolean(options.refreshMv)
      };

  if (parsed.refreshMv) {
    const { refreshAmPlatinumMaterializedViews } = await import('../src/supabase/materialized-views.js');
    await refreshAmPlatinumMaterializedViews();
  }

  const lyRange = getLastYearComparableRange(parsed.cyStart, parsed.cyEnd);
  const report = {
    generatedAt: new Date().toISOString(),
    table: OPERATION_WISE_TABLE,
    cyWindow: { start: parsed.cyStart, end: parsed.cyEnd },
    lyWindow: { start: lyRange.startIso, end: lyRange.endIso },
    dealers: [],
    pass: true
  };

  await withPostgresClient(async client => {
    await client.query('SET statement_timeout = 0');
    const columns = await tableColumns(client);

    for (const dealerCode of parsed.dealers) {
      const periods = await listPeriodsForDealer(client, dealerCode);
      const required = await validateRequiredColumns(client, dealerCode, columns);
      const cyRows = await validateCyPeriod(client, dealerCode, parsed.cyStart, parsed.cyEnd);
      const lyStatus = await getComparableLyStatus(client, {
        dealerCode,
        cyStartIso: parsed.cyStart,
        cyEndIso: parsed.cyEnd
      });
      const cyVas = await validateVasRows(client, dealerCode, parsed.cyStart, parsed.cyEnd);
      const lyVas = lyStatus.hasExactLyPeriod
        ? await validateVasRows(client, dealerCode, lyRange.startIso, lyRange.endIso)
        : { vasRows: 0, vasAmount: 0 };
      const vasSummary = await queryVasPeriodSummary(client, dealerCode);

      const blocking = [];
      if (!required.pass) blocking.push(...required.issues);
      if (cyRows === 0) blocking.push(`missing CY period ${parsed.cyStart} to ${parsed.cyEnd}`);
      if (!lyStatus.hasExactLyPeriod) {
        blocking.push(`missing exact LY period ${lyRange.startIso} to ${lyRange.endIso}`);
      }

      const nonComparableFullMonth = periods.filter(period =>
        period.periodStart === lyRange.startIso &&
        !isPeriodComparableToWindow(
          period.periodStart,
          period.periodEnd,
          lyRange.startIso,
          lyRange.endIso
        ).comparable
      );

      const dealerReport = {
        dealerCode,
        pass: blocking.length === 0,
        cyPeriod: { start: parsed.cyStart, end: parsed.cyEnd, rows: cyRows, vasRows: cyVas.vasRows, vasAmount: cyVas.vasAmount },
        lyPeriod: {
          start: lyRange.startIso,
          end: lyRange.endIso,
          exactRows: lyStatus.exactLyRows,
          vasRows: lyVas.vasRows,
          vasAmount: lyVas.vasAmount
        },
        periodsUploaded: periods.slice(0, 12),
        nonComparableLyPeriods: nonComparableFullMonth,
        vasSummaryAvailable: vasSummary !== null,
        vasSummary: vasSummary?.slice(0, 6) ?? null,
        blockingIssues: blocking
      };

      report.dealers.push(dealerReport);
      if (!dealerReport.pass) {
        report.pass = false;
      }
    }
  });

  printReport(report);
  return report;
}

function printReport(report) {
  console.log('');
  console.log('='.repeat(90));
  console.log('  AM Platinum Operation Wise Upload Validation');
  console.log('='.repeat(90));
  console.log(`  Table: ${report.table}`);
  console.log(`  CY window: ${report.cyWindow.start} to ${report.cyWindow.end}`);
  console.log(`  LY window: ${report.lyWindow.start} to ${report.lyWindow.end}`);
  console.log(`  Overall: ${report.pass ? 'PASS' : 'FAIL'} (${report.dealers.length} dealers)`);
  console.log('');
  console.log('  Dealer   | CY rows | LY exact | Status');
  console.log('  ---------|---------|----------|--------');
  for (const dealer of report.dealers) {
    const cyRows = String(dealer.cyPeriod.rows).padStart(7);
    const lyExact = String(dealer.lyPeriod.exactRows).padStart(8);
    const status = dealer.pass ? 'PASS' : 'FAIL';
    console.log(`  ${dealer.dealerCode.padEnd(8)} |${cyRows} |${lyExact} | ${status}`);
  }
  console.log('');

  for (const dealer of report.dealers) {
    console.log(`Dealer ${dealer.dealerCode}: ${dealer.pass ? 'PASS' : 'FAIL'}`);
    console.log(`  CY ${dealer.cyPeriod.start} to ${dealer.cyPeriod.end}: ${dealer.cyPeriod.rows} rows | VAS rows=${dealer.cyPeriod.vasRows} amount=${dealer.cyPeriod.vasAmount}`);
    console.log(`  LY ${dealer.lyPeriod.start} to ${dealer.lyPeriod.end}: exactRows=${dealer.lyPeriod.exactRows} | VAS rows=${dealer.lyPeriod.vasRows} amount=${dealer.lyPeriod.vasAmount}`);

    if (dealer.nonComparableLyPeriods.length) {
      console.log('  Non-comparable LY periods (full month etc.):');
      for (const period of dealer.nonComparableLyPeriods.slice(0, 5)) {
        console.log(`    - ${period.periodStart} to ${period.periodEnd} (${period.rowCount} rows)`);
      }
    }

    if (dealer.blockingIssues.length) {
      console.log('  Blocking issues:');
      for (const issue of dealer.blockingIssues) {
        console.log(`    - ${issue}`);
      }
    }

    if (dealer.vasSummaryAvailable && dealer.vasSummary?.length) {
      console.log(`  ${VAS_PERIOD_SUMMARY_VIEW} (latest):`);
      for (const row of dealer.vasSummary) {
        console.log(`    - ${row.period_start} to ${row.period_end}: vas_amount=${row.vas_amount} source_rows=${row.source_rows}`);
      }
    } else if (dealer.vasSummaryAvailable === false) {
      console.log(`  ${VAS_PERIOD_SUMMARY_VIEW}: view not found`);
    }

    console.log('');
  }
}

const isMain = process.argv[1]?.includes('validate-am-platinum-operation-wise-upload.js');
if (isMain) {
  validateAmPlatinumOperationWiseUpload().catch(error => {
    console.error('Validation failed:', error);
    process.exitCode = 1;
  });
}
