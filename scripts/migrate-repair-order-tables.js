import 'dotenv/config';
import {
  HYUNDAI_REPAIR_ORDER_CANONICAL_COLUMNS,
  hyundaiRepairOrderRowToDatabaseRow
} from '../src/reports/hyundai-repair-order-schema.js';
import { hashDataObjectForTable } from '../src/supabase/row-identity.js';
import { quoteIdentifier, withPostgresClient } from '../src/supabase/postgres.js';
import { logger } from '../src/utils/logger.js';

const TABLES = [
  'hyundai_repair_order_list',
  'am_platinum_repair_order_list'
];

const DATE_COLUMNS = new Set(['r_o_date', 'sale_date']);
const NUMERIC_COLUMNS = new Set(['visit_count']);
const INSERT_BATCH_SIZE = 1000;

function toIsoDate(value) {
  if (value == null || String(value).trim() === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slash) {
    const dd = String(Number(slash[1])).padStart(2, '0');
    const mm = String(Number(slash[2])).padStart(2, '0');
    return `${slash[3]}-${mm}-${dd}`;
  }

  return null;
}

function toNullableText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function toNullableNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalizeDbRow(row) {
  const canonical = hyundaiRepairOrderRowToDatabaseRow(row, {
    dealerCode: row?.dlr_no ?? row?.dealer ?? row?.dealer_code ?? row?.source_dealer_code ?? ''
  });

  const normalized = {};
  for (const column of HYUNDAI_REPAIR_ORDER_CANONICAL_COLUMNS) {
    const value = canonical[column];
    if (DATE_COLUMNS.has(column)) {
      normalized[column] = toIsoDate(value);
    } else if (NUMERIC_COLUMNS.has(column)) {
      normalized[column] = toNullableNumber(value);
    } else {
      normalized[column] = toNullableText(value);
    }
  }

  return normalized;
}

function completenessScore(row) {
  return Object.values(row).filter(value => value != null && String(value).trim() !== '').length;
}

function shouldKeepRow(row) {
  return Boolean(row.r_o_no || row.vin || row.reg_no);
}

function pickPreferredRow(current, candidate) {
  const currentScore = completenessScore(current.data);
  const candidateScore = completenessScore(candidate.data);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }

  const currentUploadedAt = current.uploadedAt ? new Date(current.uploadedAt).getTime() : 0;
  const candidateUploadedAt = candidate.uploadedAt ? new Date(candidate.uploadedAt).getTime() : 0;
  if (candidateUploadedAt !== currentUploadedAt) {
    return candidateUploadedAt > currentUploadedAt ? candidate : current;
  }

  return Number(candidate.sourceId) > Number(current.sourceId) ? candidate : current;
}

function tableDefinitionSql(tableName) {
  const table = quoteIdentifier(tableName);
  return `
    create table if not exists public.${table} (
      id bigserial primary key,
      row_hash text not null,
      no text,
      r_o_no text,
      r_o_date date,
      r_o_status text,
      reg_no text,
      vin text,
      vehicle_type text,
      night_service text,
      model text,
      sale_date date,
      work_type text,
      svc_adv text,
      tech_name text,
      uc_category text,
      hiib_y_n text,
      mobile_service text,
      special_message text,
      ro_source text,
      high_risk_customer text,
      quick_service_status text,
      dlr_no text,
      visit_type text,
      visit_count numeric,
      uploaded_at timestamptz default now()
    )
  `;
}

async function fetchSourceRows(client, tableName) {
  const table = quoteIdentifier(tableName);
  const result = await client.query(`
    select
      id,
      uploaded_at,
      to_jsonb(${table}) - 'id' - 'row_hash' - 'uploaded_at' as data
    from public.${table}
    order by id
  `);

  return result.rows;
}

function dedupeRows(tableName, rows) {
  const byHash = new Map();
  let skippedEmpty = 0;

  for (const row of rows) {
    const data = canonicalizeDbRow(row.data ?? {});
    if (!shouldKeepRow(data)) {
      skippedEmpty += 1;
      continue;
    }

    const rowHash = hashDataObjectForTable(tableName, data);
    const candidate = {
      rowHash,
      data,
      uploadedAt: row.uploaded_at,
      sourceId: row.id
    };
    const current = byHash.get(rowHash);
    byHash.set(rowHash, current ? pickPreferredRow(current, candidate) : candidate);
  }

  return {
    rows: [...byHash.values()],
    skippedEmpty
  };
}

async function alignCanonicalSchema(client, tableName) {
  const table = `public.${quoteIdentifier(tableName)}`;
  await client.query(tableDefinitionSql(tableName));

  const requiredColumns = [
    ['row_hash', 'text'],
    ['no', 'text'],
    ['r_o_no', 'text'],
    ['r_o_date', 'date'],
    ['r_o_status', 'text'],
    ['reg_no', 'text'],
    ['vin', 'text'],
    ['vehicle_type', 'text'],
    ['night_service', 'text'],
    ['model', 'text'],
    ['sale_date', 'date'],
    ['work_type', 'text'],
    ['svc_adv', 'text'],
    ['tech_name', 'text'],
    ['uc_category', 'text'],
    ['hiib_y_n', 'text'],
    ['mobile_service', 'text'],
    ['special_message', 'text'],
    ['ro_source', 'text'],
    ['high_risk_customer', 'text'],
    ['quick_service_status', 'text'],
    ['dlr_no', 'text'],
    ['visit_type', 'text'],
    ['visit_count', 'numeric'],
    ['uploaded_at', 'timestamptz default now()']
  ];

  for (const [columnName, columnType] of requiredColumns) {
    await client.query(`
      alter table ${table}
      add column if not exists ${quoteIdentifier(columnName)} ${columnType}
    `);
  }
}

async function pruneUnexpectedColumns(client, tableName) {
  const allowed = new Set(['id', 'row_hash', 'uploaded_at', ...HYUNDAI_REPAIR_ORDER_CANONICAL_COLUMNS]);
  const result = await client.query(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
      order by ordinal_position
    `,
    [tableName]
  );

  const removable = result.rows
    .map(row => row.column_name)
    .filter(columnName => !allowed.has(columnName));

  if (!removable.length) return removable;

  const table = `public.${quoteIdentifier(tableName)}`;
  await client.query(`
    alter table ${table}
    ${removable.map(columnName => `drop column if exists ${quoteIdentifier(columnName)}`).join(',\n    ')}
  `);

  return removable;
}

async function dropDependentViews(client, tableName) {
  if (tableName !== 'am_platinum_repair_order_list') {
    return;
  }

  await client.query('drop materialized view if exists public.am_platinum_open_ro_daily_summary_v1');
}

async function dropLegacyTriggers(client, tableName) {
  if (tableName !== 'hyundai_repair_order_list') {
    return;
  }

  await client.query(`
    drop trigger if exists ${quoteIdentifier('hyundai_repair_order_safe_hash')}
    on public.${quoteIdentifier(tableName)}
  `);
  await client.query('drop function if exists public.hyundai_repair_order_safe_hash_trigger()');
}

async function recreateDependentViews(client, tableName) {
  if (tableName !== 'am_platinum_repair_order_list') {
    return;
  }

  await client.query(`
    create materialized view public.am_platinum_open_ro_daily_summary_v1 as
    with latest as (
      select distinct on (
        coalesce(nullif(upper(trim(both from coalesce(dlr_no, ''))), ''), 'UNMAPPED'),
        coalesce(nullif(trim(both from r_o_no), ''), id::text)
      )
        coalesce(nullif(upper(trim(both from coalesce(dlr_no, ''))), ''), 'UNMAPPED') as dealer_code,
        r_o_date as report_date,
        coalesce(nullif(svc_adv, ''), 'Unspecified') as advisor,
        coalesce(nullif(work_type, ''), 'Others') as work_type,
        greatest((current_date - r_o_date), 0) as aging_days,
        uploaded_at
      from public.am_platinum_repair_order_list
      where lower(coalesce(r_o_status, '')) = 'open'
        and r_o_date is not null
      order by
        coalesce(nullif(upper(trim(both from coalesce(dlr_no, ''))), ''), 'UNMAPPED'),
        coalesce(nullif(trim(both from r_o_no), ''), id::text),
        uploaded_at desc nulls last,
        id desc
    )
    select
      dealer_code,
      report_date,
      advisor,
      work_type,
      count(*)::integer as open_ro,
      avg(aging_days) as avg_aging,
      count(*) filter (where aging_days > 15)::integer as over_15,
      max(uploaded_at) as uploaded_at
    from latest
    group by dealer_code, report_date, advisor, work_type
  `);
  await client.query(`
    create unique index if not exists ${quoteIdentifier('idx_am_platinum_open_ro_daily_summary_v1')}
    on public.${quoteIdentifier('am_platinum_open_ro_daily_summary_v1')}(dealer_code, report_date, advisor, work_type)
  `);
}

async function recreateIndexes(client, tableName) {
  const table = `public.${quoteIdentifier(tableName)}`;
  await client.query(`
    alter table ${table}
    drop constraint if exists ${quoteIdentifier(`${tableName}_row_hash_key`)}
  `);
  const staleIndexes = [
    `idx_${tableName}_row_hash`,
    `idx_${tableName}_dealer_code`,
    `idx_${tableName}_source_dealer_code`,
    `idx_${tableName}_work_type`,
    `idx_${tableName}_sale_date`,
    `idx_${tableName}_r_o_date`,
    `idx_${tableName}_cancel_date`,
    `idx_${tableName}_ro_date`,
    `idx_${tableName}_service_type`,
    'idx_hyundai_repair_order_dealer_norm',
    'hyundai_repair_order_open_dealer_date_idx',
    'idx_hyundai_repair_order_open_date',
    'am_platinum_open_ro_fast_lookup_idx'
  ];

  for (const indexName of staleIndexes) {
    await client.query(`drop index if exists public.${quoteIdentifier(indexName)}`);
  }

  await client.query(`
    create unique index if not exists ${quoteIdentifier(`idx_${tableName}_row_hash`)}
    on ${table}(row_hash)
  `);
  await client.query(`
    create index if not exists ${quoteIdentifier(`idx_${tableName}_dlr_no`)}
    on ${table}(dlr_no)
  `);
  await client.query(`
    create index if not exists ${quoteIdentifier(`idx_${tableName}_r_o_no`)}
    on ${table}(r_o_no)
  `);
  await client.query(`
    create index if not exists ${quoteIdentifier(`idx_${tableName}_r_o_date`)}
    on ${table}(r_o_date)
  `);
  await client.query(`
    create index if not exists ${quoteIdentifier(`idx_${tableName}_r_o_status`)}
    on ${table}(r_o_status)
  `);
  await client.query(`
    create index if not exists ${quoteIdentifier(`idx_${tableName}_vin`)}
    on ${table}(vin)
  `);
  await client.query(`
    create index if not exists ${quoteIdentifier(`idx_${tableName}_reg_no`)}
    on ${table}(reg_no)
  `);
  await client.query(`
    create index if not exists ${quoteIdentifier(`idx_${tableName}_open_lookup`)}
    on ${table}(dlr_no, r_o_date, r_o_no, uploaded_at desc)
    where lower(coalesce(r_o_status, '')) = 'open'
  `);
}

async function insertCanonicalRows(client, tableName, rows) {
  const table = `public.${quoteIdentifier(tableName)}`;
  const recordDefinition = `
    row_hash text,
    no text,
    r_o_no text,
    r_o_date date,
    r_o_status text,
    reg_no text,
    vin text,
    vehicle_type text,
    night_service text,
    model text,
    sale_date date,
    work_type text,
    svc_adv text,
    tech_name text,
    uc_category text,
    hiib_y_n text,
    mobile_service text,
    special_message text,
    ro_source text,
    high_risk_customer text,
    quick_service_status text,
    dlr_no text,
    visit_type text,
    visit_count numeric,
    uploaded_at timestamptz
  `;

  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    const batch = rows.slice(index, index + INSERT_BATCH_SIZE);
    const payload = batch.map(row => ({
      row_hash: row.rowHash,
      ...row.data,
      uploaded_at: row.uploadedAt ?? new Date().toISOString()
    }));

    await client.query(
      `
        insert into ${table} (
          row_hash,
          no,
          r_o_no,
          r_o_date,
          r_o_status,
          reg_no,
          vin,
          vehicle_type,
          night_service,
          model,
          sale_date,
          work_type,
          svc_adv,
          tech_name,
          uc_category,
          hiib_y_n,
          mobile_service,
          special_message,
          ro_source,
          high_risk_customer,
          quick_service_status,
          dlr_no,
          visit_type,
          visit_count,
          uploaded_at
        )
        select
          row_hash,
          no,
          r_o_no,
          r_o_date,
          r_o_status,
          reg_no,
          vin,
          vehicle_type,
          night_service,
          model,
          sale_date,
          work_type,
          svc_adv,
          tech_name,
          uc_category,
          hiib_y_n,
          mobile_service,
          special_message,
          ro_source,
          high_risk_customer,
          quick_service_status,
          dlr_no,
          visit_type,
          visit_count,
          uploaded_at
        from jsonb_to_recordset($1::jsonb) as source(${recordDefinition})
      `,
      [JSON.stringify(payload)]
    );
  }
}

async function migrateTable(client, tableName) {
  const existingRows = await fetchSourceRows(client, tableName);
  const { rows, skippedEmpty } = dedupeRows(tableName, existingRows);

  await client.query('begin');
  try {
    await alignCanonicalSchema(client, tableName);
    await client.query(`truncate table public.${quoteIdentifier(tableName)} restart identity`);
    await insertCanonicalRows(client, tableName, rows);
    await dropDependentViews(client, tableName);
    await dropLegacyTriggers(client, tableName);
    const removedColumns = await pruneUnexpectedColumns(client, tableName);
    await recreateIndexes(client, tableName);
    await recreateDependentViews(client, tableName);
    await client.query('commit');

    return {
      tableName,
      sourceRowCount: existingRows.length,
      insertedRowCount: rows.length,
      dedupedRowCount: existingRows.length - skippedEmpty - rows.length,
      skippedEmptyRowCount: skippedEmpty,
      removedColumns
    };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

const requestedTablesArg = process.argv.find(arg => arg.startsWith('--tables='));
const selectedTables = requestedTablesArg
  ? requestedTablesArg.slice('--tables='.length).split(',').map(value => value.trim()).filter(Boolean)
  : TABLES;

const summaries = await withPostgresClient(async client => {
  await client.query('set statement_timeout = 0');
  const results = [];
  for (const tableName of selectedTables) {
    logger.info('Migrating repair-order table to canonical schema', { tableName });
    results.push(await migrateTable(client, tableName));
  }
  return results;
});

console.log(JSON.stringify(summaries, null, 2));
