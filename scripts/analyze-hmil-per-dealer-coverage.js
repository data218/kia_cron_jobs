import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { createHmilReportDefinitions, getSelectedHmilReports } from '../src/reports/hmil-reports.js';
import { normalizeTableName } from '../src/supabase/relational-store.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';
import { toIsoDate } from '../src/utils/date-range.js';

const TARGET_START = '2025-01-01';
const TARGET_END = toIsoDate(new Date());
const CURRENT_MONTH_START = `${TARGET_END.slice(0, 7)}-01`;
const EXCLUDED_REPORT_IDS = new Set([
  'hyundai-repair-order-list',
  'hyundai-ro-billing-report',
  'hyundai-operation-wise-analysis-report'
]);

const TABLE_SPECS = [
  {
    reportId: 'hyundai-call-center-complaints',
    dateColumns: ['complaint_date', 'call_date', 'created_date']
  },
  {
    reportId: 'hyundai-demo-car-list',
    dateColumns: ['hmi_invoice_date', 'reg_date', 'registration_date', 'invoice_date']
  },
  {
    reportId: 'hyundai-service-appointment',
    dateColumns: ['b_t_date_time', 'appointment_date', 'booking_date', 'a_t_date_time']
  },
  {
    reportId: 'hyundai-trust-package-bodyshop-sot',
    dateColumns: ['reg_date', 'package_purchase_date', 'purchase_date']
  },
  {
    reportId: 'hyundai-trust-package-sot-super',
    dateColumns: ['reg_date', 'package_purchase_date', 'purchase_date']
  },
  {
    reportId: 'hyundai-trust-package-package-list',
    dateColumns: ['reg_date', 'package_purchase_date', 'purchase_date']
  },
  {
    reportId: 'hyundai-psf-yearly',
    dateColumns: ['psf_date', 'survey_date', 'bill_date', 'r_o_date']
  },
  {
    reportId: 'hyundai-ew-report',
    dateColumns: ['reg_date', 'purchase_date', 'invoice_date']
  },
  {
    reportId: 'hyundai-adv-wise-lubricants-vas',
    dateColumns: ['bill_date', 'invoice_date', 'ro_date', 'r_o_date']
  },
  {
    reportId: 'hyundai-open-ro-yearly',
    dateColumns: ['ro_date', 'r_o_date', 'bill_date']
  }
];

const primaryAccount = createGdmsAccountProfile('hmil');
const secondaryAccount = createGdmsAccountProfile('hmil-secondary');
const reportDefinitions = createHmilReportDefinitions(primaryAccount);
const reportsById = new Map(reportDefinitions.map(report => [report.id, report]));
const defaultReportIds = getSelectedHmilReports('all', primaryAccount)
  .map(report => report.id)
  .filter(reportId => !EXCLUDED_REPORT_IDS.has(reportId));
const dealers = [...new Set([
  ...(primaryAccount.dealerCodes.length ? primaryAccount.dealerCodes : []),
  ...(secondaryAccount.dealerCodes.length ? secondaryAccount.dealerCodes : [])
])];

function resolveSpec(reportId) {
  const report = reportsById.get(reportId);
  if (!report) {
    throw new Error(`Unknown HMIL report definition for ${reportId}`);
  }

  const spec = TABLE_SPECS.find(entry => entry.reportId === reportId);
  if (!spec) {
    throw new Error(`Missing coverage spec for ${reportId}`);
  }

  return {
    ...spec,
    sheetName: report.sheetName,
    table: normalizeTableName(report.sheetName),
    reportName: report.name
  };
}

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

async function analyzeDealerCoverage(client, { table, dealerColumn, dateColumn, dealerCode }) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS row_count,
            MIN(${quoteIdentifier(dateColumn)})::date AS min_date,
            MAX(${quoteIdentifier(dateColumn)})::date AS max_date
     FROM public.${quoteIdentifier(table)}
     WHERE upper(trim(${quoteIdentifier(dealerColumn)}::text)) = upper(trim($1::text))
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
  const exists = await tableExists(client, spec.table);
  if (!exists) {
    return {
      ...spec,
      exists: false,
      dealers: Object.fromEntries(
        dealers.map(dealerCode => [
          dealerCode,
          { complete: false, rowCount: 0, minDate: null, maxDate: null, reasons: ['table missing'] }
        ])
      )
    };
  }

  const columns = await tableColumns(client, spec.table);
  const dealerColumn = resolveDealerColumn(columns);
  const dateColumn = resolveDateColumn(columns, spec.dateColumns);

  if (!dealerColumn) {
    return {
      ...spec,
      exists: true,
      dealerColumn: null,
      dateColumn,
      dealers: Object.fromEntries(
        dealers.map(dealerCode => [
          dealerCode,
          { complete: false, rowCount: 0, minDate: null, maxDate: null, reasons: ['no dealer column'] }
        ])
      )
    };
  }

  if (!dateColumn) {
    const dealerResults = {};
    for (const dealerCode of dealers) {
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS row_count
         FROM public.${quoteIdentifier(spec.table)}
         WHERE upper(trim(${quoteIdentifier(dealerColumn)}::text)) = upper(trim($1::text))`,
        [dealerCode]
      );
      const rowCount = Number(countResult.rows[0]?.row_count ?? 0);
      dealerResults[dealerCode] = {
        complete: false,
        rowCount,
        minDate: null,
        maxDate: null,
        reasons: rowCount > 0 ? ['no business date column'] : ['no rows']
      };
    }

    return {
      ...spec,
      exists: true,
      dealerColumn,
      dateColumn: null,
      dealers: dealerResults
    };
  }

  const dealerResults = {};
  for (const dealerCode of dealers) {
    dealerResults[dealerCode] = await analyzeDealerCoverage(client, {
      table: spec.table,
      dealerColumn,
      dateColumn,
      dealerCode
    });
  }

  return {
    ...spec,
    exists: true,
    dealerColumn,
    dateColumn,
    dealers: dealerResults
  };
}

function buildQueue(tableResults) {
  const queue = [];

  for (const result of tableResults) {
    for (const dealerCode of dealers) {
      const dealer = result.dealers[dealerCode];
      if (dealer.complete) continue;

      queue.push({
        reportId: result.reportId,
        reportName: result.reportName,
        table: result.table,
        sheetName: result.sheetName,
        dealerCode,
        reason: dealer.reasons.join('; ') || 'incomplete coverage',
        rowCount: dealer.rowCount,
        minDate: dealer.minDate,
        maxDate: dealer.maxDate
      });
    }
  }

  return queue;
}

function summarizeMissingReports(queue) {
  const grouped = new Map();

  for (const item of queue) {
    if (!grouped.has(item.reportId)) {
      grouped.set(item.reportId, {
        reportId: item.reportId,
        reportName: item.reportName,
        dealers: [],
        reasons: new Set()
      });
    }

    const entry = grouped.get(item.reportId);
    entry.dealers.push(item.dealerCode);
    for (const part of item.reason.split(';').map(value => value.trim()).filter(Boolean)) {
      entry.reasons.add(part);
    }
  }

  return [...grouped.values()].map(entry => ({
    reportId: entry.reportId,
    reportName: entry.reportName,
    dealers: [...new Set(entry.dealers)].sort(),
    reasons: [...entry.reasons]
  }));
}

function printReport(tableResults, queue, missingReports) {
  console.log('');
  console.log('='.repeat(96));
  console.log('  HMIL Hyundai Coverage (excluding RO Billing, Repair Order, Operation Wise)');
  console.log('='.repeat(96));
  console.log(`  Target: ${TARGET_START} -> ${TARGET_END} (current month from ${CURRENT_MONTH_START})`);
  console.log(`  Dealers: ${dealers.join(', ')}`);
  console.log('');

  for (const result of tableResults) {
    console.log(`${result.table}`);
    console.log(`  reportId: ${result.reportId}`);

    if (!result.exists) {
      console.log('  status: TABLE MISSING');
      console.log('');
      continue;
    }

    console.log(`  date column: ${result.dateColumn ?? 'n/a'} | dealer column: ${result.dealerColumn ?? 'n/a'}`);
    for (const dealerCode of dealers) {
      const dealer = result.dealers[dealerCode];
      const status = dealer.complete ? 'COMPLETE' : 'MISSING';
      const range = dealer.minDate || dealer.maxDate
        ? `${dealer.minDate ?? '?'} -> ${dealer.maxDate ?? '?'}`
        : 'no data';
      console.log(`    ${dealerCode}: ${status} | rows=${dealer.rowCount} | ${range}`);
      if (dealer.reasons.length) {
        console.log(`             ${dealer.reasons.join('; ')}`);
      }
    }
    console.log('');
  }

  console.log('='.repeat(96));
  console.log('  MISSING REPORTS');
  console.log('='.repeat(96));
  if (!missingReports.length) {
    console.log('  All non-excluded HMIL reports have Jan 2025 -> current-month coverage for all configured dealers.');
  } else {
    for (const item of missingReports) {
      console.log(`  ${item.reportId}`);
      console.log(`    dealers: ${item.dealers.join(', ')}`);
      console.log(`    reasons: ${item.reasons.join('; ')}`);
    }
  }

  console.log('');
  console.log(`  Missing dealer/report pairs: ${queue.length}`);
  console.log('');
}

export async function analyzeHmilPerDealerCoverage({ writeReport = true } = {}) {
  const targetReportIds = defaultReportIds.filter(reportId => !EXCLUDED_REPORT_IDS.has(reportId));
  const specs = targetReportIds.map(resolveSpec);

  const tableResults = await withPostgresClient(async client => {
    await client.query('SET statement_timeout = 0');
    await client.query(`SET DateStyle = 'ISO, DMY'`);
    const results = [];
    for (const spec of specs) {
      results.push(await analyzeTable(client, spec));
    }
    return results;
  });

  const queue = buildQueue(tableResults);
  const missingReports = summarizeMissingReports(queue);
  const payload = {
    generatedAt: new Date().toISOString(),
    targetStart: TARGET_START,
    targetEnd: TARGET_END,
    currentMonthStart: CURRENT_MONTH_START,
    dealers,
    excludedReportIds: [...EXCLUDED_REPORT_IDS],
    tables: tableResults,
    queue,
    missingReports
  };

  if (writeReport) {
    const outputPath = path.join(config.logsDir, 'hmil-coverage-gap-report.json');
    await fs.mkdir(config.logsDir, { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2));
    console.log(`Report written to ${outputPath}`);
  }

  printReport(tableResults, queue, missingReports);
  return payload;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.includes('analyze-hmil-per-dealer-coverage.js')) {
  analyzeHmilPerDealerCoverage().catch(error => {
    console.error('Analysis failed:', error);
    process.exitCode = 1;
  });
}
