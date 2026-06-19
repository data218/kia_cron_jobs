import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseExcelFile } from '../src/excel/parse-workbook.js';
import {
  saveReportSheetToRelationalTable
} from '../src/supabase/relational-store.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';

const DEALER_CODE = 'N6250';
const REPAIR_DIR =
  'C:/Users/sahil/Downloads/Repair oder list (NH6250)_March_2024_to_June_2026';
const BILLING_DIR =
  'C:/Users/sahil/Downloads/Ro Billing Report(NH6250)_March_2024_to_June_2026';
const AUDIT_DIR = path.resolve('logs', 'platinum-excel-imports');

const IMPORTS = [
  {
    id: 'repair-order',
    directory: REPAIR_DIR,
    sheetName: 'AM Platinum Repair Order List',
    tableName: 'am_platinum_repair_order_list',
    identityHeader: 'R/O No',
    dateHeader: 'R/O Date',
    dealerHeaders: ['Dealer']
  },
  {
    id: 'ro-billing',
    directory: BILLING_DIR,
    sheetName: 'AM Platinum RO Billing Report',
    tableName: 'am_platinum_ro_billing_report',
    identityHeader: 'Bill No',
    dateHeader: 'Bill Date',
    dealerHeaders: ['Main Dealer Code', 'Dealer Code']
  }
];

function normalizedText(value) {
  return String(value ?? '').trim();
}

function parseDate(value) {
  const text = normalizedText(value);
  if (!text) return null;
  const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

function rowContentHash(row) {
  const entries = Object.entries(row)
    .filter(([key]) => !['No.', 'S NO', 'source_dealer_code'].includes(key))
    .map(([key, value]) => [key, normalizedText(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function mergeRowsByIdentity(rows, identityHeader, sourceFiles) {
  const identities = new Map();
  const duplicates = [];
  const conflicts = [];

  rows.forEach((row, index) => {
    const identity = normalizedText(row[identityHeader]).toUpperCase();
    if (!identity) {
      conflicts.push({
        identity: null,
        reason: `Missing ${identityHeader}`,
        sourceFile: sourceFiles[index]
      });
      return;
    }

    const hash = rowContentHash(row);
    const existing = identities.get(identity);
    if (!existing) {
      identities.set(identity, { row, hash, sourceFile: sourceFiles[index] });
      return;
    }

    if (existing.hash === hash) {
      duplicates.push({
        identity,
        keptFile: existing.sourceFile,
        skippedFile: sourceFiles[index]
      });
      return;
    }

    conflicts.push({
      identity,
      reason: 'Same business identity has different row content',
      firstFile: existing.sourceFile,
      secondFile: sourceFiles[index]
    });
  });

  return {
    rows: [...identities.values()].map(item => item.row),
    duplicateCount: duplicates.length,
    duplicates: duplicates.slice(0, 100),
    conflicts
  };
}

async function collectImport(definition) {
  const fileNames = (await fs.readdir(definition.directory))
    .filter(name => name.toLowerCase().endsWith('.xlsx'))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  if (!fileNames.length) {
    throw new Error(`No Excel files found in ${definition.directory}`);
  }

  const allRows = [];
  const sourceFiles = [];
  let expectedHeaders = null;
  const fileResults = [];
  const invalidDealers = [];
  const invalidDates = [];

  for (const fileName of fileNames) {
    const filePath = path.join(definition.directory, fileName);
    const parsed = await parseExcelFile(filePath);
    expectedHeaders ??= parsed.headers;
    if (JSON.stringify(parsed.headers) !== JSON.stringify(expectedHeaders)) {
      throw new Error(`${definition.id}: header mismatch in ${fileName}`);
    }

    const dates = [];
    for (const originalRow of parsed.rows) {
      for (const header of definition.dealerHeaders) {
        const dealer = normalizedText(originalRow[header]).toUpperCase();
        if (dealer && dealer !== DEALER_CODE) {
          invalidDealers.push({ fileName, header, dealer });
        }
      }

      const date = parseDate(originalRow[definition.dateHeader]);
      if (!date) {
        invalidDates.push({
          fileName,
          identity: originalRow[definition.identityHeader],
          value: originalRow[definition.dateHeader]
        });
      } else {
        dates.push(date);
      }

      allRows.push({
        source_dealer_code: DEALER_CODE,
        ...originalRow
      });
      sourceFiles.push(fileName);
    }

    fileResults.push({
      fileName,
      rowCount: parsed.rows.length,
      minimumDate: dates.length ? dates.sort()[0] : null,
      maximumDate: dates.length ? dates.sort().at(-1) : null
    });
  }

  const merged = mergeRowsByIdentity(
    allRows,
    definition.identityHeader,
    sourceFiles
  );
  const allDates = merged.rows
    .map(row => parseDate(row[definition.dateHeader]))
    .filter(Boolean)
    .sort();

  return {
    ...definition,
    headers: ['source_dealer_code', ...expectedHeaders],
    rows: merged.rows,
    fileCount: fileNames.length,
    rawRowCount: allRows.length,
    uniqueRowCount: merged.rows.length,
    duplicateCount: merged.duplicateCount,
    duplicateSamples: merged.duplicates,
    conflicts: merged.conflicts,
    invalidDealers,
    invalidDates,
    minimumDate: allDates[0] ?? null,
    maximumDate: allDates.at(-1) ?? null,
    files: fileResults
  };
}

async function databaseSnapshot(imports) {
  return withPostgresClient(async client => {
    const results = [];
    for (const item of imports) {
      const table = quoteIdentifier(item.tableName);
      const identityColumn = item.id === 'repair-order' ? 'r_o_no' : 'bill_no';
      const dateColumn = item.id === 'repair-order' ? 'r_o_date' : 'bill_date';
      const result = await client.query(`
        select
          count(*)::int as row_count,
          count(distinct ${quoteIdentifier(identityColumn)})::int as identity_count,
          min(${quoteIdentifier(dateColumn)})::text as minimum_date,
          max(${quoteIdentifier(dateColumn)})::text as maximum_date
        from public.${table}
        where upper(trim(coalesce(source_dealer_code::text, dealer_code::text, ''))) = $1
      `, [DEALER_CODE]);
      results.push({ tableName: item.tableName, ...result.rows[0] });
    }
    return results;
  });
}

async function createBackups(imports, stamp) {
  return withPostgresClient(async client => {
    const backups = [];
    await client.query('begin');
    try {
      for (const item of imports) {
        const table = quoteIdentifier(item.tableName);
        const backupName = `${item.tableName}_n6250_backup_${stamp}`;
        const backup = quoteIdentifier(backupName);
        await client.query(`
          create table public.${backup} as
          select *
          from public.${table}
          where upper(trim(coalesce(source_dealer_code::text, dealer_code::text, ''))) = $1
        `, [DEALER_CODE]);
        const count = await client.query(
          `select count(*)::int as count from public.${backup}`
        );
        backups.push({ backupName, rowCount: count.rows[0].count });
      }
      await client.query('commit');
      return backups;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

function canonicalDealerSql(item) {
  if (item.id === 'repair-order') {
    return `
      upper(trim(coalesce(
        nullif(nullif(source_dealer_code, ''), 'ACTIVE'),
        nullif(dealer_code, ''),
        nullif(dealer, '')
      )))
    `;
  }
  return `
    upper(trim(coalesce(
      nullif(nullif(source_dealer_code, ''), 'ACTIVE'),
      nullif(dealer_code, ''),
      nullif(main_dealer_code, '')
    )))
  `;
}

async function reconcileDuplicatesAndProtect(imports) {
  return withPostgresClient(async client => {
    const results = [];
    await client.query('begin');
    try {
      for (const item of imports) {
        const table = quoteIdentifier(item.tableName);
        const identityColumn = item.id === 'repair-order' ? 'r_o_no' : 'bill_no';
        const identity = quoteIdentifier(identityColumn);
        const canonicalDealer = canonicalDealerSql(item);
        const before = await client.query(`
          select count(*)::int as count
          from (
            select ${identity}
            from public.${table}
            where ${canonicalDealer} = $1
              and nullif(trim(${identity}), '') is not null
            group by ${identity}
            having count(*) > 1
          ) duplicate_groups
        `, [DEALER_CODE]);

        const deleted = await client.query(`
          with ranked as (
            select
              id,
              row_number() over (
                partition by upper(trim(${identity}))
                order by uploaded_at desc nulls last, id desc
              ) as duplicate_rank
            from public.${table}
            where ${canonicalDealer} = $1
              and nullif(trim(${identity}), '') is not null
          )
          delete from public.${table} target
          using ranked
          where target.id = ranked.id
            and ranked.duplicate_rank > 1
          returning target.id
        `, [DEALER_CODE]);

        const indexName = `uq_${item.tableName}_n6250_identity`;
        await client.query(`
          create unique index if not exists ${quoteIdentifier(indexName)}
          on public.${table} (
            (${canonicalDealer}),
            (upper(trim(${identity})))
          )
          where ${canonicalDealer} = 'N6250'
            and nullif(trim(${identity}), '') is not null
        `);

        results.push({
          tableName: item.tableName,
          duplicateGroupsBefore: before.rows[0].count,
          duplicateRowsRemoved: deleted.rowCount,
          protectiveIndex: indexName
        });
      }
      await client.query('commit');
      return results;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

async function duplicateSnapshot(imports) {
  return withPostgresClient(async client => {
    const results = [];
    for (const item of imports) {
      const table = quoteIdentifier(item.tableName);
      const identityColumn = item.id === 'repair-order' ? 'r_o_no' : 'bill_no';
      const identity = quoteIdentifier(identityColumn);
      const canonicalDealer = canonicalDealerSql(item);
      const result = await client.query(`
        select
          count(*)::int as duplicate_group_count,
          coalesce(sum(row_count - 1), 0)::int as duplicate_row_count
        from (
          select count(*)::int as row_count
          from public.${table}
          where ${canonicalDealer} = $1
            and nullif(trim(${identity}), '') is not null
          group by upper(trim(${identity}))
          having count(*) > 1
        ) duplicate_groups
      `, [DEALER_CODE]);
      results.push({ tableName: item.tableName, ...result.rows[0] });
    }
    return results;
  });
}

async function writeAudit(payload) {
  await fs.mkdir(AUDIT_DIR, { recursive: true });
  const filePath = path.join(AUDIT_DIR, `n6250-import-${payload.stamp}.json`);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const imports = [];

  for (const definition of IMPORTS) {
    imports.push(await collectImport(definition));
  }

  const validationErrors = imports.flatMap(item => [
    ...item.conflicts.map(value => ({ report: item.id, type: 'identity_conflict', ...value })),
    ...item.invalidDealers.map(value => ({ report: item.id, type: 'invalid_dealer', ...value })),
    ...item.invalidDates.map(value => ({ report: item.id, type: 'invalid_date', ...value }))
  ]);
  const before = await databaseSnapshot(imports);
  const audit = {
    stamp,
    mode: execute ? 'execute' : 'dry-run',
    dealerCode: DEALER_CODE,
    imports: imports.map(({ rows, headers, ...summary }) => summary),
    databaseBefore: before,
    validationErrors
  };

  if (validationErrors.length) {
    audit.status = 'blocked';
    audit.auditFile = await writeAudit(audit);
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  if (!execute) {
    audit.status = 'validated';
    audit.auditFile = await writeAudit(audit);
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    return;
  }

  audit.backups = await createBackups(imports, stamp);
  audit.uploads = [];
  for (const item of imports) {
    audit.uploads.push(await saveReportSheetToRelationalTable({
      sheetName: item.sheetName,
      headers: item.headers,
      rows: item.rows
    }));
  }
  audit.reconciliation = await reconcileDuplicatesAndProtect(imports);
  audit.databaseAfter = await databaseSnapshot(imports);
  audit.duplicatesAfter = await duplicateSnapshot(imports);
  if (audit.duplicatesAfter.some(item => item.duplicate_group_count !== 0)) {
    throw new Error('Duplicate verification failed after upload');
  }
  audit.status = 'completed';
  audit.auditFile = await writeAudit(audit);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
