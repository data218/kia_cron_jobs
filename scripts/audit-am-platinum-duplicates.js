import 'dotenv/config';
import {
  AM_PLATINUM_TABLES,
  groupRowsByIdentityHash,
  hashDataObjectForTable
} from '../src/supabase/row-identity.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';

const OPERATION_WISE_TABLE = 'am_platinum_operation_wise_analysis_report';
const SAMPLE_LIMIT = 5;

function pad(value, width, right = false) {
  return right ? String(value).padStart(width) : String(value).padEnd(width);
}

function formatSampleValue(value) {
  if (value == null) return '';
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function sampleFields(data) {
  const keys = [
    'source_dealer_code',
    'dealer_code',
    'bill_no',
    'r_o_no',
    'ro_no',
    'complaint_no',
    'report_type',
    'report_period_start',
    'report_period_end',
    'report_month',
    'op_part_code',
    'vin',
    'vin_no',
    'certi_no',
    'cert_no'
  ];

  return keys
    .filter(key => data?.[key] != null && String(data[key]).trim() !== '')
    .slice(0, 6)
    .map(key => `${key}=${formatSampleValue(data[key])}`)
    .join(', ');
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = $1
      limit 1
    `,
    [tableName]
  );
  return result.rowCount > 0;
}

async function auditRowHashDuplicates(client, tableName) {
  const result = await client.query(
    `
      select
        count(*)::int as total,
        count(distinct row_hash)::int as unique_hashes,
        count(*) filter (where row_hash is null)::int as null_hashes
      from public.${quoteIdentifier(tableName)}
    `
  );

  const row = result.rows[0];
  const rowHashDupes = row.total - row.unique_hashes;

  return {
    totalRows: row.total,
    rowHashDupes,
    nullHashes: row.null_hashes
  };
}

async function auditIdentityDuplicates(client, tableName) {
  const table = `public.${quoteIdentifier(tableName)}`;
  const result = await client.query(
    `
      select
        id,
        row_hash,
        uploaded_at,
        to_jsonb(${quoteIdentifier(tableName)}) - 'id' - 'row_hash' - 'uploaded_at' as data
      from ${table}
      order by id
    `
  );

  const {
    idsToDelete,
    duplicateGroups,
    duplicateGroupCount
  } = groupRowsByIdentityHash(tableName, result.rows);

  return {
    identityDupes: idsToDelete.length,
    identityDuplicateGroups: duplicateGroupCount,
    sampleGroups: duplicateGroups.slice(0, SAMPLE_LIMIT)
  };
}

async function auditCrossDealerOperationWise(client, tableName) {
  if (tableName !== OPERATION_WISE_TABLE) {
    return {
      crossDealerGroups: 0,
      crossDealerExtraRows: 0,
      sampleGroups: []
    };
  }

  const columnsResult = await client.query(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
    `,
    [tableName]
  );
  const columns = new Set(columnsResult.rows.map(row => row.column_name));
  const dealerExpr = columns.has('source_dealer_code')
    ? 'source_dealer_code'
    : columns.has('dealer_code')
      ? 'dealer_code'
      : null;

  if (!dealerExpr) {
    return {
      crossDealerGroups: 0,
      crossDealerExtraRows: 0,
      sampleGroups: []
    };
  }

  const result = await client.query(
    `
      select
        report_type,
        report_period_start::text as report_period_start,
        report_period_end::text as report_period_end,
        op_part_code,
        count(distinct ${quoteIdentifier(dealerExpr)})::int as dealer_count,
        count(*)::int as row_count,
        array_agg(distinct ${quoteIdentifier(dealerExpr)}) as dealer_codes,
        array_agg(id order by id) as ids
      from public.${quoteIdentifier(tableName)}
      where op_part_code is not null
        and trim(op_part_code::text) <> ''
      group by report_type, report_period_start, report_period_end, op_part_code
      having count(distinct ${quoteIdentifier(dealerExpr)}) > 1
      order by row_count desc
      limit 1000
    `
  );

  const crossDealerExtraRows = result.rows.reduce(
    (sum, row) => sum + Math.max(0, row.row_count - 1),
    0
  );

  return {
    crossDealerGroups: result.rowCount,
    crossDealerExtraRows,
    sampleGroups: result.rows.slice(0, SAMPLE_LIMIT).map(row => ({
      reportType: row.report_type,
      periodStart: row.report_period_start,
      periodEnd: row.report_period_end,
      opPartCode: row.op_part_code,
      dealerCodes: row.dealer_codes,
      rowCount: row.row_count,
      ids: row.ids
    }))
  };
}

async function auditTable(client, tableName) {
  if (!(await tableExists(client, tableName))) {
    return {
      tableName,
      status: 'MISSING',
      totalRows: 0,
      rowHashDupes: 0,
      nullHashes: 0,
      identityDupes: 0,
      identityDuplicateGroups: 0,
      crossDealerGroups: 0,
      crossDealerExtraRows: 0,
      sampleGroups: [],
      crossDealerSamples: []
    };
  }

  const rowHashAudit = await auditRowHashDuplicates(client, tableName);
  if (rowHashAudit.totalRows === 0) {
    return {
      tableName,
      status: 'EMPTY',
      ...rowHashAudit,
      identityDupes: 0,
      identityDuplicateGroups: 0,
      crossDealerGroups: 0,
      crossDealerExtraRows: 0,
      sampleGroups: [],
      crossDealerSamples: []
    };
  }

  const identityAudit = await auditIdentityDuplicates(client, tableName);
  const crossDealerAudit = await auditCrossDealerOperationWise(client, tableName);

  let status = 'CLEAN';
  if (rowHashAudit.rowHashDupes > 0 || identityAudit.identityDupes > 0) {
    status = 'DUPLICATES';
  } else if (rowHashAudit.nullHashes > 0) {
    status = 'NULL_HASHES';
  } else if (crossDealerAudit.crossDealerGroups > 0) {
    status = 'CROSS_DEALER_INFO';
  }

  return {
    tableName,
    status,
    ...rowHashAudit,
    ...identityAudit,
    crossDealerGroups: crossDealerAudit.crossDealerGroups,
    crossDealerExtraRows: crossDealerAudit.crossDealerExtraRows,
    crossDealerSamples: crossDealerAudit.sampleGroups
  };
}

function printReport(results) {
  console.log('');
  console.log('═'.repeat(100));
  console.log('  AM PLATINUM DEEP DUPLICATE AUDIT');
  console.log('═'.repeat(100));
  console.log('');
  console.log(`  ${pad('Table', 45)} | ${pad('Total', 7, true)} | ${pad('HashD', 6, true)} | ${pad('IdD', 5, true)} | ${pad('NullH', 6, true)} | ${pad('XDealer', 7, true)} | Status`);
  console.log(`  ${'-'.repeat(43)}-|${'-'.repeat(8)}|${'-'.repeat(8)}|${'-'.repeat(7)}|${'-'.repeat(8)}|${'-'.repeat(9)}|----------`);

  let totalRows = 0;
  let totalRowHashDupes = 0;
  let totalIdentityDupes = 0;
  let totalNullHashes = 0;
  let totalCrossDealerGroups = 0;

  for (const result of results) {
    totalRows += result.totalRows ?? 0;
    totalRowHashDupes += result.rowHashDupes ?? 0;
    totalIdentityDupes += result.identityDupes ?? 0;
    totalNullHashes += result.nullHashes ?? 0;
    totalCrossDealerGroups += result.crossDealerGroups ?? 0;

    console.log(
      `  ${pad(result.tableName, 45)} | ${String(result.totalRows ?? 0).padStart(7)} | ${String(result.rowHashDupes ?? 0).padStart(6)} | ${String(result.identityDupes ?? 0).padStart(5)} | ${String(result.nullHashes ?? 0).padStart(6)} | ${String(result.crossDealerGroups ?? 0).padStart(7)} | ${result.status}`
    );

    if (result.sampleGroups?.length) {
      console.log(`  ${' '.repeat(45)} | identity duplicate samples:`);
      for (const group of result.sampleGroups) {
        console.log(
          `  ${' '.repeat(45)} | keep id=${group.keepId}, delete ids=[${group.deleteIds.join(', ')}], ${sampleFields(group.sample)}`
        );
      }
    }

    if (result.crossDealerSamples?.length) {
      console.log(`  ${' '.repeat(45)} | cross-dealer op-wise samples (informational only):`);
      for (const group of result.crossDealerSamples) {
        console.log(
          `  ${' '.repeat(45)} | ${group.reportType} ${group.periodStart}..${group.periodEnd} ${group.opPartCode} dealers=[${group.dealerCodes.join(', ')}] rows=${group.rowCount}`
        );
      }
    }
  }

  console.log(`  ${'-'.repeat(43)}-|${'-'.repeat(8)}|${'-'.repeat(8)}|${'-'.repeat(7)}|${'-'.repeat(8)}|${'-'.repeat(9)}|----------`);
  console.log('');
  console.log(`  Tables scanned           : ${results.length}`);
  console.log(`  Total rows               : ${totalRows}`);
  console.log(`  row_hash duplicates      : ${totalRowHashDupes}`);
  console.log(`  identity duplicates      : ${totalIdentityDupes}`);
  console.log(`  NULL row_hash rows       : ${totalNullHashes}`);
  console.log(`  cross-dealer op-wise grps: ${totalCrossDealerGroups} (informational, not auto-deleted)`);
  console.log('');

  if (totalIdentityDupes > 0 || totalRowHashDupes > 0) {
    console.log('  Overall status           : DUPLICATES FOUND');
    console.log('  Next step                : npm run am-platinum:dedupe:dry-run');
    console.log('                             npm run am-platinum:dedupe');
  } else if (totalNullHashes > 0) {
    console.log('  Overall status           : NULL HASH ROWS FOUND');
    console.log('  Next step                : npm run am-platinum:dedupe');
  } else if (totalCrossDealerGroups > 0) {
    console.log('  Overall status           : CLEAN ON IDENTITY; cross-dealer op-wise rows flagged for review');
  } else {
    console.log('  Overall status           : ALL CLEAN');
  }

  console.log('');
}

async function main() {
  const results = await withPostgresClient(async client => {
    await client.query('SET statement_timeout = 0');
    const audits = [];
    for (const tableName of AM_PLATINUM_TABLES) {
      console.error(`Auditing ${tableName}...`);
      audits.push(await auditTable(client, tableName));
    }
    return audits;
  });

  printReport(results);

  const hasDupes = results.some(result =>
    (result.rowHashDupes ?? 0) > 0 || (result.identityDupes ?? 0) > 0);
  if (hasDupes) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Audit failed:', error);
  process.exitCode = 1;
});

export {
  auditTable,
  hashDataObjectForTable
};
