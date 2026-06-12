import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';
import { toIsoDate } from '../src/utils/date-range.js';

const TARGET_START = '2021-01-01';
const TARGET_END = toIsoDate(new Date());
const CURRENT_MONTH_START = `${TARGET_END.slice(0, 7)}-01`;

const QUEUE_FILE = path.join(config.logsDir, 'am-platinum-historical-queue.json');

const DEALERS = config.amPlatinumDealerCodes?.length
  ? config.amPlatinumDealerCodes
  : ['N5211', 'N6824', 'N6828'];

const TABLE_SPECS = [
  {
    table: 'am_platinum_repair_order_list',
    reportId: 'hyundai-repair-order-list',
    dateColumns: ['r_o_date', 'ro_date', 'bill_date'],
    runner: 'historical'
  },
  {
    table: 'am_platinum_ro_billing_report',
    reportId: 'hyundai-ro-billing-report',
    dateColumns: ['bill_date'],
    runner: 'historical'
  },
  {
    table: 'am_platinum_call_center_complaints',
    reportId: 'hyundai-call-center-complaints',
    dateColumns: ['complaint_date', 'call_date', 'created_date'],
    runner: 'historical'
  },
  {
    table: 'am_platinum_demo_car_list',
    reportId: 'hyundai-demo-car-list',
    dateColumns: ['reg_date', 'registration_date', 'invoice_date'],
    runner: 'historical'
  },
  {
    table: 'am_platinum_service_appointment',
    reportId: 'hyundai-service-appointment',
    dateColumns: ['appointment_date', 'booking_date', 'a_t_date_time'],
    runner: 'historical'
  },
  {
    table: 'am_platinum_trust_package',
    reportId: 'hyundai-trust-package-bodyshop-sot',
    dateColumns: ['reg_date', 'package_purchase_date', 'purchase_date'],
    runner: 'historical',
    extraReportIds: [
      'hyundai-trust-package-sot-super',
      'hyundai-trust-package-package-list'
    ]
  },
  {
    table: 'am_platinum_psf_yearly',
    reportId: 'hyundai-psf-yearly',
    dateColumns: ['psf_date', 'survey_date', 'bill_date', 'r_o_date'],
    runner: 'historical'
  },
  {
    table: 'am_platinum_ew_report',
    reportId: 'hyundai-ew-report',
    dateColumns: ['reg_date', 'purchase_date', 'invoice_date'],
    runner: 'historical'
  },
  {
    table: 'am_platinum_adv_wise_lubricants_vas',
    reportId: 'hyundai-adv-wise-lubricants-vas',
    dateColumns: ['bill_date', 'invoice_date', 'ro_date', 'r_o_date'],
    runner: 'optimized-historical'
  },
  {
    table: 'am_platinum_operation_wise_analysis_report',
    reportId: 'hyundai-operation-wise-analysis-report',
    dateColumns: ['report_period_start'],
    runner: 'operation-wise',
    reportTypes: ['Operation', 'Part']
  }
];

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function tableColumns(client, tableName) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return new Set(result.rows.map(row => row.column_name));
}

function resolveDealerColumn(columns) {
  return ['source_dealer_code', 'dealer_code'].find(column => columns.has(column)) ?? null;
}

function resolveDateColumn(columns, preferred) {
  for (const column of preferred) {
    if (columns.has(column)) return column;
  }
  return null;
}

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return toIsoDate(value);
  return String(value).slice(0, 10);
}

function hasFullDateCoverage(minDate, maxDate) {
  if (!minDate || !maxDate) return false;
  return minDate <= TARGET_START && maxDate >= CURRENT_MONTH_START;
}

async function analyzeDealerCoverage(client, { table, dealerColumn, dateColumn, dealerCode, reportTypes }) {
  const dealerFilter = `upper(trim(${quoteIdentifier(dealerColumn)}::text)) = upper(trim($1::text))`;

  if (reportTypes?.length) {
    const typeResults = [];

    for (const reportType of reportTypes) {
      const result = await client.query(
        `SELECT COUNT(*)::int AS row_count,
                MIN(${quoteIdentifier(dateColumn)})::date AS min_date,
                MAX(COALESCE(report_period_end, ${quoteIdentifier(dateColumn)}))::date AS max_date,
                COUNT(DISTINCT report_month)::int AS month_count
         FROM public.${quoteIdentifier(table)}
         WHERE ${dealerFilter}
           AND report_type = $2`,
        [dealerCode, reportType]
      );

      const row = result.rows[0];
      const minDate = toDateOnly(row.min_date);
      const maxDate = toDateOnly(row.max_date);
      const rowCount = Number(row.row_count ?? 0);
      const monthCount = Number(row.month_count ?? 0);

      typeResults.push({
        reportType,
        rowCount,
        minDate,
        maxDate,
        monthCount,
        complete: rowCount > 0 && hasFullDateCoverage(minDate, maxDate)
      });
    }

    const complete = typeResults.every(entry => entry.complete);
    const reasons = [];

    for (const entry of typeResults) {
      if (entry.complete) continue;
      if (entry.rowCount === 0) {
        reasons.push(`${entry.reportType}: no rows`);
      } else if (!entry.minDate || entry.minDate > TARGET_START) {
        reasons.push(`${entry.reportType}: starts ${entry.minDate ?? 'unknown'} (need ${TARGET_START})`);
      } else if (!entry.maxDate || entry.maxDate < CURRENT_MONTH_START) {
        reasons.push(`${entry.reportType}: ends ${entry.maxDate ?? 'unknown'} (need through ${CURRENT_MONTH_START})`);
      } else {
        reasons.push(`${entry.reportType}: incomplete coverage`);
      }
    }

    return {
      rowCount: typeResults.reduce((sum, entry) => sum + entry.rowCount, 0),
      minDate: typeResults.map(entry => entry.minDate).filter(Boolean).sort()[0] ?? null,
      maxDate: typeResults.map(entry => entry.maxDate).filter(Boolean).sort().at(-1) ?? null,
      complete,
      reasons,
      reportTypes: typeResults
    };
  }

  const result = await client.query(
    `SELECT COUNT(*)::int AS row_count,
            MIN(${quoteIdentifier(dateColumn)})::date AS min_date,
            MAX(${quoteIdentifier(dateColumn)})::date AS max_date
     FROM public.${quoteIdentifier(table)}
     WHERE ${dealerFilter}
       AND ${quoteIdentifier(dateColumn)} IS NOT NULL`,
    [dealerCode]
  );

  const row = result.rows[0];
  const minDate = toDateOnly(row.min_date);
  const maxDate = toDateOnly(row.max_date);
  const rowCount = Number(row.row_count ?? 0);
  const complete = rowCount > 0 && hasFullDateCoverage(minDate, maxDate);
  const reasons = [];

  if (!complete) {
    if (rowCount === 0) {
      reasons.push('no rows');
    } else if (!minDate || minDate > TARGET_START) {
      reasons.push(`starts ${minDate ?? 'unknown'} (need ${TARGET_START})`);
    } else if (!maxDate || maxDate < CURRENT_MONTH_START) {
      reasons.push(`ends ${maxDate ?? 'unknown'} (need through ${CURRENT_MONTH_START})`);
    } else {
      reasons.push('incomplete coverage');
    }
  }

  return { rowCount, minDate, maxDate, complete, reasons };
}

async function analyzeTable(client, spec) {
  const { table, reportId, dateColumns, runner, reportTypes, extraReportIds = [] } = spec;
  const exists = await tableExists(client, table);

  if (!exists) {
    return {
      table,
      reportId,
      runner,
      exists: false,
      dealers: Object.fromEntries(
        DEALERS.map(dealerCode => [
          dealerCode,
          { complete: false, rowCount: 0, minDate: null, maxDate: null, reasons: ['table missing'] }
        ])
      )
    };
  }

  const columns = await tableColumns(client, table);
  const dealerColumn = resolveDealerColumn(columns);
  const dateColumn = resolveDateColumn(columns, dateColumns);

  if (!dealerColumn) {
    return {
      table,
      reportId,
      runner,
      exists: true,
      dealers: Object.fromEntries(
        DEALERS.map(dealerCode => [
          dealerCode,
          { complete: false, rowCount: 0, minDate: null, maxDate: null, reasons: ['no dealer column'] }
        ])
      )
    };
  }

  if (!dateColumn) {
    const dealers = {};
    for (const dealerCode of DEALERS) {
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS row_count
         FROM public.${quoteIdentifier(table)}
         WHERE upper(trim(${quoteIdentifier(dealerColumn)}::text)) = upper(trim($1::text))`,
        [dealerCode]
      );
      const rowCount = Number(countResult.rows[0]?.row_count ?? 0);
      dealers[dealerCode] = {
        rowCount,
        minDate: null,
        maxDate: null,
        complete: false,
        reasons: rowCount > 0 ? ['no business date column; cannot verify Jan 2021 coverage'] : ['no rows']
      };
    }

    return { table, reportId, runner, exists: true, dateColumn: null, dealerColumn, dealers, extraReportIds };
  }

  const dealers = {};
  for (const dealerCode of DEALERS) {
    dealers[dealerCode] = await analyzeDealerCoverage(client, {
      table,
      dealerColumn,
      dateColumn,
      dealerCode,
      reportTypes
    });
  }

  return {
    table,
    reportId,
    runner,
    exists: true,
    dateColumn,
    dealerColumn,
    dealers,
    extraReportIds
  };
}

function buildQueue(tableResults) {
  const queue = [];

  for (const result of tableResults) {
    for (const dealerCode of DEALERS) {
      const dealer = result.dealers[dealerCode];
      if (dealer.complete) continue;

      queue.push({
        reportId: result.reportId,
        table: result.table,
        dealerCode,
        runner: result.runner,
        reason: dealer.reasons.join('; ') || 'incomplete historical coverage',
        rowCount: dealer.rowCount,
        minDate: dealer.minDate,
        maxDate: dealer.maxDate,
        reportTypes: dealer.reportTypes ?? null
      });
    }
  }

  return queue;
}

function groupQueueForHistoricalRun(queue) {
  const grouped = new Map();

  for (const item of queue) {
    if (item.runner === 'operation-wise') continue;

    const key = item.runner === 'optimized-historical'
      ? `optimized:${item.reportId}`
      : `historical:${item.reportId}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        runner: item.runner,
        reportId: item.reportId,
        dealers: new Set()
      });
    }

    grouped.get(key).dealers.add(item.dealerCode);
  }

  return [...grouped.values()].map(entry => ({
    runner: entry.runner,
    reportId: entry.reportId,
    dealers: [...entry.dealers].sort()
  }));
}

function printReport(tableResults, queue, groupedRuns) {
  console.log('');
  console.log('═'.repeat(100));
  console.log('  AM Platinum Per-Dealer Historical Coverage (Jan 2021 → Today)');
  console.log('═'.repeat(100));
  console.log(`  Target: ${TARGET_START} → ${TARGET_END} (current month from ${CURRENT_MONTH_START})`);
  console.log(`  Dealers: ${DEALERS.join(', ')}`);
  console.log('');

  for (const result of tableResults) {
    console.log(`${result.table}`);
    console.log(`  reportId: ${result.reportId} | runner: ${result.runner}`);
    if (!result.exists) {
      console.log('  status: TABLE MISSING — all dealers need backfill');
      console.log('');
      continue;
    }

    if (result.dateColumn) {
      console.log(`  date column: ${result.dateColumn} | dealer column: ${result.dealerColumn}`);
    } else {
      console.log(`  warning: no business date column (${result.dealerColumn ?? 'n/a'})`);
    }

    for (const dealerCode of DEALERS) {
      const dealer = result.dealers[dealerCode];
      const status = dealer.complete ? '✅ COMPLETE' : '❌ NEEDS BACKFILL';
      const range = dealer.minDate || dealer.maxDate
        ? `${dealer.minDate ?? '?'} → ${dealer.maxDate ?? '?'}`
        : 'no data';
      console.log(`    ${dealerCode}: ${status} | rows=${dealer.rowCount} | ${range}`);
      if (!dealer.complete && dealer.reasons.length) {
        console.log(`             ${dealer.reasons.join('; ')}`);
      }
      if (dealer.reportTypes?.length) {
        for (const typeEntry of dealer.reportTypes) {
          const typeStatus = typeEntry.complete ? 'ok' : 'missing';
          console.log(`             ${typeEntry.reportType}: ${typeStatus} (${typeEntry.minDate ?? '?'} → ${typeEntry.maxDate ?? '?'})`);
        }
      }
    }
    console.log('');
  }

  console.log('═'.repeat(100));
  console.log('  QUEUE SUMMARY');
  console.log('═'.repeat(100));
  console.log(`  Missing dealer/report pairs: ${queue.length}`);
  console.log('');

  if (queue.length === 0) {
    console.log('  ✅ All dealers have full historical coverage for all platinum tables.');
  } else {
    console.log('  dealer   | reportId                               | runner              | reason');
    console.log('  ---------|----------------------------------------|---------------------|------------------------------');
    for (const item of queue) {
      const dealer = item.dealerCode.padEnd(8);
      const report = item.reportId.padEnd(38);
      const runner = item.runner.padEnd(19);
      console.log(`  ${dealer} | ${report} | ${runner} | ${item.reason}`);
    }
    console.log('');
    console.log('  Planned historical runs (grouped):');
    for (const run of groupedRuns) {
      console.log(`    - ${run.runner}: ${run.reportId} → dealers ${run.dealers.join(', ')}`);
    }
    const operationWisePending = queue.filter(item => item.runner === 'operation-wise');
    if (operationWisePending.length) {
      console.log(`    - operation-wise recovery handles ${operationWisePending.length} dealer gap(s)`);
    }
  }

  console.log('');
}

export async function analyzeAmPlatinumPerDealerCoverage({ writeQueue = true } = {}) {
  const tableResults = await withPostgresClient(async client => {
    // Coverage scans aggregate large tables; Supabase default timeout (~8s) is too low.
    await client.query('SET statement_timeout = 0');

    const results = [];
    for (const spec of TABLE_SPECS) {
      results.push(await analyzeTable(client, spec));
    }
    return results;
  });

  const queue = buildQueue(tableResults);
  const groupedRuns = groupQueueForHistoricalRun(queue);
  const payload = {
    generatedAt: new Date().toISOString(),
    targetStart: TARGET_START,
    targetEnd: TARGET_END,
    currentMonthStart: CURRENT_MONTH_START,
    dealers: DEALERS,
    tables: tableResults,
    queue,
    groupedRuns,
    operationWisePending: queue.filter(item => item.runner === 'operation-wise'),
    historicalPending: groupedRuns
  };

  if (writeQueue) {
    await fs.mkdir(config.logsDir, { recursive: true });
    await fs.writeFile(QUEUE_FILE, JSON.stringify(payload, null, 2));
    console.log(`Queue written to ${QUEUE_FILE}`);
  }

  printReport(tableResults, queue, groupedRuns);
  return payload;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.includes('analyze-am-platinum-per-dealer-coverage.js')) {
  analyzeAmPlatinumPerDealerCoverage().catch(error => {
    console.error('Analysis failed:', error);
    process.exitCode = 1;
  });
}
