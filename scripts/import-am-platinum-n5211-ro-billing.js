import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseExcelFile } from '../src/excel/parse-workbook.js';
import { saveReportSheetToRelationalTable } from '../src/supabase/relational-store.js';
import { withPostgresClient } from '../src/supabase/postgres.js';

const DEALER_CODE = 'N5211';
const SOURCE_DIR =
  'C:/Users/sahil/Downloads/Ro_billing_report_NH5211_January_2021_to_June_2026';
const TABLE_NAME = 'am_platinum_ro_billing_report';
const SHEET_NAME = 'AM Platinum RO Billing Report';
const AUDIT_DIR = path.resolve('logs', 'platinum-excel-imports');
const DEALER_SQL = `
  upper(trim(coalesce(
    nullif(nullif(source_dealer_code, ''), 'ACTIVE'),
    nullif(dealer_code, ''),
    nullif(main_dealer_code, '')
  )))
`;

function text(value) {
  return String(value ?? '').trim();
}

function parseDate(value) {
  const raw = text(value);
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : null;
}

function contentHash(row) {
  const entries = Object.entries(row)
    .filter(([key]) => !['S NO', 'source_dealer_code'].includes(key))
    .map(([key, value]) => [key, text(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

async function collectSource() {
  const files = (await fs.readdir(SOURCE_DIR))
    .filter(name => name.toLowerCase().endsWith('.xlsx'))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (!files.length) throw new Error(`No Excel files found in ${SOURCE_DIR}`);

  let expectedHeaders = null;
  let rawRowCount = 0;
  let exactDuplicateCount = 0;
  const invalidDealers = [];
  const invalidDates = [];
  const conflicts = [];
  const identities = new Map();
  const dates = [];

  for (const fileName of files) {
    const parsed = await parseExcelFile(path.join(SOURCE_DIR, fileName));
    expectedHeaders ??= parsed.headers;
    if (JSON.stringify(parsed.headers) !== JSON.stringify(expectedHeaders)) {
      throw new Error(`Header mismatch in ${fileName}`);
    }

    for (const original of parsed.rows) {
      rawRowCount += 1;
      for (const header of ['Main Dealer Code', 'Dealer Code']) {
        const dealer = text(original[header]).toUpperCase();
        if (dealer && dealer !== DEALER_CODE) {
          invalidDealers.push({ fileName, header, dealer });
        }
      }

      const date = parseDate(original['Bill Date']);
      if (!date) {
        invalidDates.push({
          fileName,
          billNo: original['Bill No'],
          value: original['Bill Date']
        });
      } else {
        dates.push(date);
      }

      const billNo = text(original['Bill No']).toUpperCase();
      if (!billNo) {
        conflicts.push({ fileName, reason: 'Missing Bill No' });
        continue;
      }

      const row = { source_dealer_code: DEALER_CODE, ...original };
      const hash = contentHash(row);
      const existing = identities.get(billNo);
      if (!existing) {
        identities.set(billNo, { row, hash, fileName });
      } else if (existing.hash === hash) {
        exactDuplicateCount += 1;
      } else {
        conflicts.push({
          billNo,
          reason: 'Same Bill No has conflicting values',
          firstFile: existing.fileName,
          secondFile: fileName
        });
      }
    }
  }

  dates.sort();
  return {
    headers: ['source_dealer_code', ...expectedHeaders],
    rows: [...identities.values()].map(item => item.row),
    summary: {
      fileCount: files.length,
      rawRowCount,
      uniqueBillCount: identities.size,
      exactDuplicateCount,
      conflictCount: conflicts.length,
      conflicts: conflicts.slice(0, 100),
      invalidDealers,
      invalidDates,
      minimumDate: dates[0] ?? null,
      maximumDate: dates.at(-1) ?? null
    }
  };
}

async function snapshot() {
  return withPostgresClient(async client => {
    const coverage = await client.query(`
      select
        count(*)::int as row_count,
        count(distinct upper(trim(bill_no)))::int as identity_count,
        min(bill_date)::text as minimum_date,
        max(bill_date)::text as maximum_date
      from public.${TABLE_NAME}
      where ${DEALER_SQL} = $1
    `, [DEALER_CODE]);
    const duplicates = await client.query(`
      select
        count(*)::int as duplicate_group_count,
        coalesce(sum(row_count - 1), 0)::int as duplicate_row_count
      from (
        select count(*)::int as row_count
        from public.${TABLE_NAME}
        where ${DEALER_SQL} = $1
          and nullif(trim(bill_no), '') is not null
        group by upper(trim(bill_no))
        having count(*) > 1
      ) duplicate_groups
    `, [DEALER_CODE]);
    return { ...coverage.rows[0], ...duplicates.rows[0] };
  });
}

async function countSourceKeysPresent(rows) {
  const keys = rows.map(row => text(row['Bill No']).toUpperCase());
  return withPostgresClient(async client => {
    let found = 0;
    for (let index = 0; index < keys.length; index += 2000) {
      const result = await client.query(`
        select count(distinct upper(trim(bill_no)))::int as count
        from public.${TABLE_NAME}
        where ${DEALER_SQL} = $1
          and upper(trim(bill_no)) = any($2::text[])
      `, [DEALER_CODE, keys.slice(index, index + 2000)]);
      found += result.rows[0].count;
    }
    return found;
  });
}

async function createBackup(stamp) {
  const backupName = `${TABLE_NAME}_n5211_backup_${stamp}`;
  return withPostgresClient(async client => {
    await client.query('begin');
    try {
      await client.query(`
        create table public.${backupName} as
        select *
        from public.${TABLE_NAME}
        where ${DEALER_SQL} = $1
      `, [DEALER_CODE]);
      const count = await client.query(
        `select count(*)::int as count from public.${backupName}`
      );
      await client.query('commit');
      return { backupName, rowCount: count.rows[0].count };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

async function reconcileAndProtect() {
  return withPostgresClient(async client => {
    await client.query('begin');
    try {
      const deleted = await client.query(`
        with ranked as (
          select
            id,
            row_number() over (
              partition by upper(trim(bill_no))
              order by uploaded_at desc nulls last, id desc
            ) as duplicate_rank
          from public.${TABLE_NAME}
          where ${DEALER_SQL} = $1
            and nullif(trim(bill_no), '') is not null
        )
        delete from public.${TABLE_NAME} target
        using ranked
        where target.id = ranked.id
          and ranked.duplicate_rank > 1
        returning target.id
      `, [DEALER_CODE]);

      const indexName = 'uq_am_platinum_ro_billing_report_n5211_identity';
      await client.query(`
        create unique index if not exists ${indexName}
        on public.${TABLE_NAME} (
          (${DEALER_SQL}),
          (upper(trim(bill_no)))
        )
        where ${DEALER_SQL} = 'N5211'
          and nullif(trim(bill_no), '') is not null
      `);
      await client.query('commit');
      return { duplicateRowsRemoved: deleted.rowCount, protectiveIndex: indexName };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

async function writeAudit(audit) {
  await fs.mkdir(AUDIT_DIR, { recursive: true });
  const filePath = path.join(AUDIT_DIR, `n5211-ro-billing-${audit.stamp}.json`);
  await fs.writeFile(filePath, JSON.stringify(audit, null, 2));
  return filePath;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const source = await collectSource();
  const errors = [
    ...source.summary.conflicts,
    ...source.summary.invalidDealers,
    ...source.summary.invalidDates
  ];
  const audit = {
    stamp,
    mode: execute ? 'execute' : 'dry-run',
    dealerCode: DEALER_CODE,
    source: source.summary,
    databaseBefore: await snapshot(),
    sourceKeysPresentBefore: await countSourceKeysPresent(source.rows),
    validationErrorCount: errors.length
  };

  if (errors.length) {
    audit.status = 'blocked';
    audit.validationErrors = errors.slice(0, 200);
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

  audit.backup = await createBackup(stamp);
  audit.upload = await saveReportSheetToRelationalTable({
    sheetName: SHEET_NAME,
    headers: source.headers,
    rows: source.rows
  });
  audit.reconciliation = await reconcileAndProtect();
  audit.databaseAfter = await snapshot();
  audit.sourceKeysPresentAfter = await countSourceKeysPresent(source.rows);

  if (
    audit.sourceKeysPresentAfter !== source.summary.uniqueBillCount ||
    audit.databaseAfter.duplicate_group_count !== 0
  ) {
    throw new Error('Post-upload verification failed');
  }

  audit.status = 'completed';
  audit.auditFile = await writeAudit(audit);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
