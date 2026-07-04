import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { quoteIdentifier, withPostgresClient } from './postgres.js';
import { createSupabaseClient } from './client.js';
import {
  NON_BUSINESS_HASH_COLUMNS,
  WARRANTY_TABLES,
  fullRowContentHash,
  identityGroupsForTable,
  resolveBusinessIdentityKey,
  tableRequiresExactRowDedupe
} from './row-identity.js';
import { HYUNDAI_REPAIR_ORDER_CANONICAL_HEADERS } from '../reports/hyundai-repair-order-schema.js';

const IMPORTANT_INDEX_COLUMNS = new Set([
  'bill_date',
  'ro_date',
  'advisor',
  'service_advisor',
  'service_type',
  'dealer_code',
  'source_dealer_code',
  'trust_package_section',
  'report_type',
  'report_month',
  'report_period_start',
  'report_period_end',
  'work_type',
  'appointment_date',
  'appointement_date',
  'booking_date',
  'uploaded_at'
]);
const RESERVED_COLUMNS = new Set([
  'id',
  'row_hash',
  'full_row_hash',
  'business_identity_key',
  'uploaded_at'
]);
const IDENTITY_COLUMN_ALIASES = {
  claim_no: ['claim_no', 'claim_number', 'warranty_claim_no'],
  r_o_no: ['r_o_no', 'ro_no'],
  dlr_no: ['dlr_no', 'dealer', 'dealer_code', 'source_dealer_code', 'sale_dealer_code'],
  claim_type: ['claim_type', 'warranty_claim_type'],
  claim_date: ['claim_date', 'warranty_claim_date'],
  ro_date: ['ro_date', 'r_o_date']
};

const STRICT_RELATIONAL_TABLE_HEADERS = {
  hyundai_repair_order_list: HYUNDAI_REPAIR_ORDER_CANONICAL_HEADERS,
  am_platinum_repair_order_list: HYUNDAI_REPAIR_ORDER_CANONICAL_HEADERS
};

const STRICT_RELATIONAL_BACKFILL_ALIASES = {
  hyundai_repair_order_list: {
    no: ['s_no', 'sno', 'sr_no', 'serial_no', 'sl_no'],
    r_o_no: ['ro_no'],
    r_o_date: ['ro_date'],
    r_o_status: ['status', 'new_r_o_status'],
    svc_adv: ['service_adv'],
    tech_name: ['man_tech', 'main_technician'],
    special_message: ['special_msg'],
    ro_source: ['source_of_ro'],
    dlr_no: ['dealer', 'dealer_code', 'source_dealer_code', 'sale_dealer_code']
  },
  am_platinum_repair_order_list: {
    no: ['s_no', 'sno', 'sr_no', 'serial_no', 'sl_no'],
    r_o_no: ['ro_no'],
    r_o_date: ['ro_date'],
    r_o_status: ['status', 'new_r_o_status'],
    svc_adv: ['service_adv'],
    tech_name: ['man_tech', 'main_technician'],
    special_message: ['special_msg'],
    ro_source: ['source_of_ro'],
    dlr_no: ['dealer', 'dealer_code', 'source_dealer_code', 'sale_dealer_code']
  }
};

const RUNTIME_DDL_DISABLED_TABLES = new Set([
  'hyundai_repair_order_list',
  'am_platinum_repair_order_list'
]);

function normalizeSqlName(value, fallback = 'column') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  const safe = normalized || fallback;
  return /^[a-z_]/.test(safe) ? safe : `${fallback}_${safe}`;
}

export function normalizeTableName(sheetName) {
  return normalizeSqlName(sheetName, 'report');
}

function uniqueColumnNames(headers) {
  const used = new Map();

  return headers.map(header => {
    const normalized = normalizeSqlName(header, 'column');
    const base = RESERVED_COLUMNS.has(normalized) ? `source_${normalized}` : normalized;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function isEmpty(value) {
  return value == null || String(value).trim() === '';
}

function headerLooksDate(header) {
  const normalized = normalizeSqlName(header);
  if (normalized.endsWith('_type')) return false;
  return /(^|_)date($|_)/.test(normalized) ||
    normalized.endsWith('_dt') ||
    normalized === 'report_month' ||
    normalized === 'report_period_start' ||
    normalized === 'report_period_end' ||
    normalized.endsWith('_period_start') ||
    normalized.endsWith('_period_end') ||
    normalized.includes('closing_date') ||
    normalized.includes('uploaded_at');
}

function isForcedTextColumn(columnName) {
  return (
    columnName === 'sac_hsn' ||
    columnName === 'hsn' ||
    columnName.endsWith('_hsn') ||
    columnName.endsWith('_code') ||
    columnName.endsWith('_no') ||
    columnName.includes('invoice') ||
    columnName.includes('irn') ||
    columnName.includes('acknowledge')
  );
}

function headerLooksNumeric(header) {
  const normalized = normalizeSqlName(header);
  if (isForcedTextColumn(normalized)) return false;
  return [
    'amt',
    'amount',
    'total',
    'tax',
    'count',
    'qty',
    'quantity',
    'mileage',
    'rate',
    'value',
    'price',
    'cgst',
    'sgst',
    'igst',
    'cess',
    'discount'
  ].some(token => normalized === token || normalized.includes(`_${token}`) || normalized.includes(`${token}_`));
}

function detectSlashDateFormat(header, rows) {
  let sawMonthDaySignal = false;
  let sawDayMonthSignal = false;

  for (const row of rows.slice(0, 200)) {
    const text = String(row?.[header] ?? '').trim();
    const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (!match) continue;

    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12) sawDayMonthSignal = true;
    if (second > 12) sawMonthDaySignal = true;
  }

  if (sawMonthDaySignal && !sawDayMonthSignal) return 'mdy';
  return 'dmy';
}

function parseDateValue(value, slashFormat = 'dmy') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value ?? '').trim();
  if (!text) return null;

  const isoLikeDate = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[tT\s].*)?$/);
  if (isoLikeDate) {
    const [, yyyy, mm, dd] = isoLikeDate;
    const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (
      date.getFullYear() === Number(yyyy) &&
      date.getMonth() === Number(mm) - 1 &&
      date.getDate() === Number(dd)
    ) {
      return [
        String(yyyy).padStart(4, '0'),
        String(mm).padStart(2, '0'),
        String(dd).padStart(2, '0')
      ].join('-');
    }
  }

  const compactYmd = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactYmd) {
    const [, yyyy, mm, dd] = compactYmd;
    const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (
      date.getFullYear() === Number(yyyy) &&
      date.getMonth() === Number(mm) - 1 &&
      date.getDate() === Number(dd)
    ) {
      return [
        String(yyyy).padStart(4, '0'),
        String(mm).padStart(2, '0'),
        String(dd).padStart(2, '0')
      ].join('-');
    }
  }

  // DD Mon YYYY — Kia Safety portal date format (e.g. "09 Jan 2025", "08 Jan 2026")
  const monDate = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (monDate) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mi = months.indexOf(monDate[2].toLowerCase());
    if (mi >= 0) {
      const dd = String(parseInt(monDate[1])).padStart(2,'0');
      const mm = String(mi + 1).padStart(2,'0');
      const yyyy = monDate[3];
      return [yyyy, mm, dd].join('-');
    }
  }

  const slashDate = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (slashDate) {
    const [, first, second, yyyy] = slashDate;
    const dd = slashFormat === 'mdy' ? second : first;
    const mm = slashFormat === 'mdy' ? first : second;
    const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (
      date.getFullYear() === Number(yyyy) &&
      date.getMonth() === Number(mm) - 1 &&
      date.getDate() === Number(dd)
    ) {
      return [
        String(yyyy).padStart(4, '0'),
        String(mm).padStart(2, '0'),
        String(dd).padStart(2, '0')
      ].join('-');
    }
  }

  const yyyymmdd = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (yyyymmdd) {
    const [, yyyy, mm, dd] = yyyymmdd;
    const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (
      date.getFullYear() === Number(yyyy) &&
      date.getMonth() === Number(mm) - 1 &&
      date.getDate() === Number(dd)
    ) {
      return [
        String(yyyy).padStart(4, '0'),
        String(mm).padStart(2, '0'),
        String(dd).padStart(2, '0')
      ].join('-');
    }
  }

  return null;
}

function parseNumericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '')
    .trim()
    .replace(/,/g, '');
  if (!text) return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function inferColumnType(header, rows) {
  const normalized = normalizeSqlName(header);
  if (isForcedTextColumn(normalized)) return 'text';
  if (headerLooksDate(header)) return 'date';
  if (headerLooksNumeric(header)) return 'numeric';

  return 'text';
}

function columnSqlType(type) {
  if (type === 'date') return 'DATE';
  if (type === 'numeric') return 'NUMERIC';
  return 'TEXT';
}

function normalizedRowEntries(row) {
  return Object.entries(row ?? {})
    .map(([key, value]) => [normalizeSqlName(key), String(value ?? '').trim()])
    .filter(([key, value]) => key && value !== '' && !NON_BUSINESS_HASH_COLUMNS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
}

function hashEntries(entries) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex');
}

function identityHashEntries(tableName, columns, normalizedValues) {
  const identityGroups = identityGroupsForTable(tableName);
  for (const group of identityGroups) {
    const entries = group
      .map(columnName => {
        const aliases = IDENTITY_COLUMN_ALIASES[columnName] ?? [columnName];
        const index = columns.findIndex(column => aliases.includes(column.name));
        return index >= 0 ? [columnName, normalizedValues[index]] : null;
      })
      .filter(entry => entry && !isEmpty(entry[1]));

    if (entries.length === group.length) {
      return [['__table', tableName], ...entries];
    }
  }

  return null;
}

function buildBusinessIdentityKey(tableName, columns, normalizedValues) {
  const data = Object.fromEntries(
    columns.map((column, index) => [column.name, normalizedValues[index]])
  );
  return resolveBusinessIdentityKey(tableName, data);
}

function buildNormalizedDataObject(columns, normalizedValues) {
  return Object.fromEntries(
    columns.map((column, index) => [column.name, normalizedValues[index]])
  );
}

function buildFullRowHash(tableName, columns, normalizedValues) {
  return fullRowContentHash(
    tableName,
    buildNormalizedDataObject(columns, normalizedValues)
  );
}

export function rowSignature(row) {
  return hashEntries(normalizedRowEntries(row));
}

export function reportRowSignature(sheetName, row) {
  const headers = Object.keys(row ?? {});
  const rows = [row ?? {}];
  const columns = buildColumns(headers, rows);
  const normalizedValues = columns.map(column => normalizeValue(row?.[column.header], column));
  return rowSignatureFromNormalizedValues(columns, normalizedValues, normalizeTableName(sheetName));
}

function rowSignatureFromNormalizedValues(columns, normalizedValues, tableName = null) {
  if (tableName) {
    const identityEntries = identityHashEntries(tableName, columns, normalizedValues);
    if (identityEntries) {
      return hashEntries(identityEntries);
    }
  }

  const entries = columns
    .map((column, index) => [column.name, normalizedValues[index]])
    .filter(([key]) => key && !NON_BUSINESS_HASH_COLUMNS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));

  return hashEntries(entries);
}

function normalizeValue(value, column, stats = null) {
  if (isEmpty(value)) return null;

  if (column.type === 'date') {
    const parsed = parseDateValue(value, column.slashDateFormat);
    if (!parsed) {
      if (stats) {
        stats.invalidDates += 1;
        stats.invalidDateColumns[column.name] = (stats.invalidDateColumns[column.name] ?? 0) + 1;
      }
      return null;
    }
    return parsed;
  }

  if (column.type === 'numeric') {
    const parsed = parseNumericValue(value);
    if (parsed == null) {
      if (stats) {
        stats.invalidNumerics += 1;
        stats.invalidNumericColumns[column.name] = (stats.invalidNumericColumns[column.name] ?? 0) + 1;
      }
      return null;
    }
    return parsed;
  }

  return String(value ?? '').trim();
}

function buildColumns(headers, rows) {
  const usableHeaders = rows.length
    ? headers.filter(header => rows.some(row => Object.prototype.hasOwnProperty.call(row ?? {}, header)))
    : headers;
  const effectiveHeaders = usableHeaders.length ? usableHeaders : headers;
  const names = uniqueColumnNames(effectiveHeaders);

  return effectiveHeaders.map((header, index) => ({
    header,
    name: names[index],
    type: inferColumnType(header, rows),
    slashDateFormat: detectSlashDateFormat(header, rows)
  }));
}

const ensuredTableSignatures = new Set();

async function getExistingColumnTypes(client, tableName) {
  const result = await client.query(
    `
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
    `,
    [tableName]
  );

  return new Map(result.rows.map(row => [row.column_name, row.data_type]));
}

async function reconcileExistingColumnTypes(client, tableName, columns) {
  const existing = await getExistingColumnTypes(client, tableName);
  if (!existing.size) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  for (const column of columns) {
    const currentType = existing.get(column.name);
    if (!currentType || currentType === 'text') continue;

    if (column.type === 'text') {
      await client.query(`
        alter table ${table}
        alter column ${quoteIdentifier(column.name)} type text
        using ${quoteIdentifier(column.name)}::text
      `);
      logger.info('Reconciled relational column to text', {
        tableName,
        column: column.name,
        previousType: currentType
      });
      continue;
    }

    if (column.type === 'date' && (currentType === 'numeric' || currentType === 'double precision' || currentType === 'integer')) {
      await client.query(`
        alter table ${table}
        alter column ${quoteIdentifier(column.name)} type date
        using nullif(${quoteIdentifier(column.name)}::text, '')::date
      `);
      logger.info('Reconciled relational column to date', {
        tableName,
        column: column.name,
        previousType: currentType
      });
    }
  }
}

async function ensureIdColumnDefault(client, tableName) {
  const table = `public.${quoteIdentifier(tableName)}`;
  const sequenceName = `${tableName}_id_seq`;
  const { rows } = await client.query(
    `
      select column_default, is_identity
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
        and column_name = 'id'
    `,
    [tableName]
  );

  if (!rows.length) return;

  const { column_default: columnDefault, is_identity: isIdentity } = rows[0];
  if (columnDefault || isIdentity === 'YES') return;

  const sequence = quoteIdentifier(sequenceName);
  await client.query(`create sequence if not exists ${sequence}`);
  await client.query(`
    alter table ${table}
    alter column id set default nextval('public.${sequenceName}'::regclass)
  `);
  await client.query(`alter sequence ${sequence} owned by ${table}.id`);
  await client.query(`
    select setval(
      'public.${sequenceName}'::regclass,
      coalesce((select max(id) from ${table}), 0) + 1,
      false
    )
  `);

  logger.info('Repaired relational table id column default', {
    tableName,
    sequenceName
  });
}

function strictColumnsForTable(tableName) {
  const headers = STRICT_RELATIONAL_TABLE_HEADERS[tableName];
  if (!headers) return null;
  return headers.map(header => normalizeSqlName(header, 'column'));
}

async function backfillStrictCanonicalColumns(client, tableName) {
  const aliasMap = STRICT_RELATIONAL_BACKFILL_ALIASES[tableName];
  if (!aliasMap) return;

  const existingColumns = await getExistingColumnTypes(client, tableName);
  if (!existingColumns.size) return;

  const assignments = Object.entries(aliasMap)
    .filter(([target]) => existingColumns.has(target))
    .map(([target, aliases]) => {
      const sources = [target, ...aliases].filter(columnName => existingColumns.has(columnName));
      if (sources.length <= 1) {
        return null;
      }

      return `${quoteIdentifier(target)} = coalesce(${sources.map(quoteIdentifier).join(', ')})`;
    })
    .filter(Boolean);

  if (!assignments.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  await client.query(`
    update ${table}
    set ${assignments.join(',\n        ')}
  `);
}

async function pruneUnexpectedColumns(client, tableName) {
  const strictColumns = strictColumnsForTable(tableName);
  if (!strictColumns) return;

  const existingColumns = await getExistingColumnTypes(client, tableName);
  const removableColumns = [...existingColumns.keys()]
    .filter(columnName => !RESERVED_COLUMNS.has(columnName))
    .filter(columnName => !strictColumns.includes(columnName));

  if (!removableColumns.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  await client.query(`
    alter table ${table}
    ${removableColumns.map(columnName => `drop column if exists ${quoteIdentifier(columnName)}`).join(',\n    ')}
  `);

  logger.info('Pruned unexpected relational columns', {
    tableName,
    removedColumns: removableColumns
  });
}

async function assertReportTableReady(client, tableName, columns, { usesBusinessKey = false, usesExactRowDedupe = false } = {}) {
  const existingColumns = await getExistingColumnTypes(client, tableName);
  if (!existingColumns.size) {
    throw new Error(`Relational table ${tableName} is missing. Run the repair-order migration/setup before importing new rows.`);
  }

  const requiredColumns = new Set([
    'id',
    'row_hash',
    'uploaded_at',
    ...columns.map(column => column.name)
  ]);

  if (usesBusinessKey) {
    requiredColumns.add('business_identity_key');
  }
  if (usesExactRowDedupe) {
    requiredColumns.add('full_row_hash');
  }

  const missingColumns = [...requiredColumns].filter(columnName => !existingColumns.has(columnName));
  if (missingColumns.length) {
    throw new Error(
      `Relational table ${tableName} is missing required columns: ${missingColumns.join(', ')}. Run the repair-order migration/setup before importing new rows.`
    );
  }
}

async function ensureReportTable(client, tableName, columns) {
  const signature = `${tableName}:${columns.map(column => `${column.name}:${column.type}`).join('|')}`;
  if (ensuredTableSignatures.has(signature)) {
    return;
  }
  const table = `public.${quoteIdentifier(tableName)}`;
  const usesExactRowDedupe = tableRequiresExactRowDedupe(tableName);
  const usesBusinessKey = WARRANTY_TABLES.has(tableName);

  if (RUNTIME_DDL_DISABLED_TABLES.has(tableName)) {
    await assertReportTableReady(client, tableName, columns, {
      usesBusinessKey,
      usesExactRowDedupe
    });
    ensuredTableSignatures.add(signature);
    return;
  }

  const columnSql = columns
    .map(column => `${quoteIdentifier(column.name)} ${columnSqlType(column.type)}`)
    .join(',\n          ');

  await client.query(`
    create table if not exists ${table} (
      id bigserial primary key,
      row_hash text not null,
      ${columnSql},
      uploaded_at timestamptz default now()
    )
  `);

  for (const column of columns) {
    await client.query(`
      alter table ${table}
      add column if not exists ${quoteIdentifier(column.name)} ${columnSqlType(column.type)}
    `);
  }

  await reconcileExistingColumnTypes(client, tableName, columns);
  await ensureIdColumnDefault(client, tableName);
  await backfillStrictCanonicalColumns(client, tableName);
  await pruneUnexpectedColumns(client, tableName);

  await client.query(`
    alter table ${table}
    add column if not exists row_hash text
  `);
  await client.query(`
    alter table ${table}
    add column if not exists uploaded_at timestamptz default now()
  `);

  if (usesExactRowDedupe) {
    await client.query(`
      do $$
      begin
        if exists (
          select 1
          from pg_constraint
          where conrelid = '${table}'::regclass
            and conname = '${tableName}_row_hash_key'
        ) then
          execute 'alter table ${table} drop constraint ${quoteIdentifier(`${tableName}_row_hash_key`)}';
        end if;
      end $$;
    `);
    await client.query(`
      drop index if exists ${quoteIdentifier(`idx_${tableName}_row_hash`)};
    `);
    await client.query(`
      create index if not exists ${quoteIdentifier(`idx_${tableName}_row_hash`)}
      on ${table}(row_hash)
    `);
  } else {
    await client.query(`
      create unique index if not exists ${quoteIdentifier(`idx_${tableName}_row_hash`)}
      on ${table}(row_hash)
    `);
  }

  const indexColumns = columns
    .map(column => column.name)
    .filter(columnName => IMPORTANT_INDEX_COLUMNS.has(columnName) || columnName.endsWith('_date'));

  for (const columnName of [...new Set([...indexColumns, 'uploaded_at'])]) {
    await client.query(`
      create index if not exists ${quoteIdentifier(`idx_${tableName}_${columnName}`)}
      on ${table}(${quoteIdentifier(columnName)})
    `);
  }

  if (usesExactRowDedupe) {
    await client.query(`
      alter table ${table}
      add column if not exists full_row_hash text
    `);
  }

  if (usesBusinessKey) {
    await client.query(`
      alter table ${table}
      add column if not exists business_identity_key text
    `);
    await client.query(`
      create unique index if not exists ${quoteIdentifier(`idx_${tableName}_business_identity_key`)}
      on ${table}(business_identity_key)
      where business_identity_key is not null
    `);
  }

  if (tableName === 'am_platinum_operation_wise_analysis_report') {
    await client.query(`
      create index if not exists ${quoteIdentifier(`idx_${tableName}_dealer_period_type`)}
      on ${table}(
        ${quoteIdentifier('source_dealer_code')},
        ${quoteIdentifier('report_period_start')},
        ${quoteIdentifier('report_period_end')},
        ${quoteIdentifier('report_type')}
      )
    `);
  }

  ensuredTableSignatures.add(signature);
}

function sqlParamCast(valueType) {
  if (valueType === 'date') return '::date';
  if (valueType === 'numeric') return '::numeric';
  if (valueType === 'timestamptz') return '::timestamptz';
  return '::text';
}

function buildInsertLayout(columns, usesBusinessKey, usesExactRowDedupe) {
  const metadata = [{ name: 'row_hash', type: 'text' }];
  if (usesBusinessKey) {
    metadata.push({ name: 'business_identity_key', type: 'text' });
  }
  if (usesExactRowDedupe) {
    metadata.push({ name: 'full_row_hash', type: 'text' });
  }

  return [
    ...metadata,
    ...columns.map(column => ({ name: column.name, type: column.type })),
    { name: 'uploaded_at', type: 'timestamptz' }
  ];
}

function prepareBatchRows(tableName, columns, batch, uploadedAt, stats, usesBusinessKey, usesExactRowDedupe) {
  return batch.map(row => {
    const normalizedValues = columns.map(column => normalizeValue(row[column.header], column, stats));
    const rowHash = rowSignatureFromNormalizedValues(columns, normalizedValues, tableName);
    const businessIdentityKey = usesBusinessKey
      ? buildBusinessIdentityKey(tableName, columns, normalizedValues)
      : null;
    const fullRowHash = usesExactRowDedupe
      ? buildFullRowHash(tableName, columns, normalizedValues)
      : null;
    const rowValues = [rowHash];
    if (usesBusinessKey) {
      rowValues.push(businessIdentityKey);
    }
    if (usesExactRowDedupe) {
      rowValues.push(fullRowHash);
    }
    rowValues.push(...normalizedValues, uploadedAt);

    return { rowHash, businessIdentityKey, fullRowHash, rowValues };
  });
}

async function filterExistingFullRowDuplicates(client, tableName, preparedRows) {
  const hashes = [...new Set(
    preparedRows
      .map(row => row.fullRowHash)
      .filter(value => !isEmpty(value))
  )];

  if (!hashes.length) {
    return { rows: preparedRows, skippedCount: 0 };
  }

  const table = `public.${quoteIdentifier(tableName)}`;
  const existing = new Set();

  for (let index = 0; index < hashes.length; index += 1000) {
    const batch = hashes.slice(index, index + 1000);
    const result = await client.query(
      `select full_row_hash from ${table} where full_row_hash = any($1::text[])`,
      [batch]
    );
    for (const row of result.rows) {
      if (!isEmpty(row.full_row_hash)) {
        existing.add(row.full_row_hash);
      }
    }
  }

  if (!existing.size) {
    return { rows: preparedRows, skippedCount: 0 };
  }

  const rows = [];
  let skippedCount = 0;
  for (const row of preparedRows) {
    if (!isEmpty(row.fullRowHash) && existing.has(row.fullRowHash)) {
      skippedCount += 1;
      continue;
    }
    rows.push(row);
  }

  return { rows, skippedCount };
}

async function backfillExactRowHashes(client, tableName, columns) {
  if (!tableRequiresExactRowDedupe(tableName)) {
    return 0;
  }

  const table = quoteIdentifier(tableName);
  const result = await client.query(
    `
      select
        id,
        to_jsonb(${table}) - 'id' - 'row_hash' - 'full_row_hash' - 'business_identity_key' - 'uploaded_at' as data
      from ${table}
      where full_row_hash is null
      order by id
    `
  );

  if (!result.rowCount) {
    return 0;
  }

  const updates = result.rows
    .map(row => {
      const normalizedValues = columns.map(column => normalizeValue(row.data?.[column.name], column));
      return {
        id: row.id,
        full_row_hash: buildFullRowHash(tableName, columns, normalizedValues)
      };
    })
    .filter(row => !isEmpty(row.full_row_hash));

  if (!updates.length) {
    return 0;
  }

  const publicTable = `public.${quoteIdentifier(tableName)}`;
  for (let index = 0; index < updates.length; index += 500) {
    const batch = updates.slice(index, index + 500);
    await client.query(
      `
        update ${publicTable} as target
        set full_row_hash = source.full_row_hash
        from jsonb_to_recordset($1::jsonb) as source(id bigint, full_row_hash text)
        where target.id = source.id
      `,
      [JSON.stringify(batch)]
    );
  }

  logger.info('Backfilled exact row hashes for relational report table', {
    tableName,
    rowCount: updates.length
  });

  return updates.length;
}

async function removeExistingExactRowDuplicates(client, tableName) {
  if (!tableRequiresExactRowDedupe(tableName)) {
    return 0;
  }

  const table = `public.${quoteIdentifier(tableName)}`;
  const result = await client.query(
    `
      with ranked as (
        select
          id,
          row_number() over (
            partition by full_row_hash
            order by uploaded_at desc nulls last, id desc
          ) as duplicate_rank
        from ${table}
        where full_row_hash is not null
      )
      delete from ${table} as target
      using ranked
      where target.id = ranked.id
        and ranked.duplicate_rank > 1
      returning target.id
    `
  );

  return result.rowCount ?? 0;
}

async function ensureExactRowUniqueIndex(client, tableName) {
  if (!tableRequiresExactRowDedupe(tableName)) {
    return;
  }

  const table = `public.${quoteIdentifier(tableName)}`;
  await client.query(`
    drop index if exists ${quoteIdentifier(`idx_${tableName}_full_row_hash`)};
  `);
  await client.query(`
    create unique index ${quoteIdentifier(`idx_${tableName}_full_row_hash`)}
    on ${table}(full_row_hash)
  `);
}

async function upsertPreparedRows(client, tableName, columns, preparedRows, usesBusinessKey, usesExactRowDedupe, conflictTarget) {
  if (!preparedRows.length) {
    return { insertedCount: 0, updatedCount: 0, skippedExistingExactDuplicateCount: 0 };
  }

  const {
    rows: filteredRows,
    skippedCount: skippedExistingExactDuplicateCount
  } = usesExactRowDedupe
    ? await filterExistingFullRowDuplicates(client, tableName, preparedRows)
    : { rows: preparedRows, skippedCount: 0 };

  if (!filteredRows.length) {
    return { insertedCount: 0, updatedCount: 0, skippedExistingExactDuplicateCount };
  }

  const table = `public.${quoteIdentifier(tableName)}`;
  const insertLayout = buildInsertLayout(columns, usesBusinessKey, usesExactRowDedupe);
  const insertColumns = insertLayout.map(column => column.name);
  const values = [];
  const rowGroups = [];
  let paramIndex = 1;

  for (const { rowValues } of filteredRows) {
    const placeholders = rowValues.map((value, columnIndex) => {
      const layoutColumn = insertLayout[columnIndex];
      const placeholder = `$${paramIndex}${sqlParamCast(layoutColumn?.type)}`;
      values.push(value);
      paramIndex += 1;
      return placeholder;
    });
    rowGroups.push(`(${placeholders.join(', ')})`);
  }

  const updateSql = columns
    .map(column => `${quoteIdentifier(column.name)} = excluded.${quoteIdentifier(column.name)}`)
    .join(',\n          ');

  const businessKeyUpdate = usesBusinessKey
    ? 'business_identity_key = excluded.business_identity_key,'
    : '';
  const fullRowHashUpdate = usesExactRowDedupe
    ? 'full_row_hash = excluded.full_row_hash,'
    : '';

  const onConflictSql = conflictTarget === 'business_identity_key'
    ? `on conflict (${quoteIdentifier(conflictTarget)}) where business_identity_key is not null do update set`
    : conflictTarget === 'vin_number_do_nothing'
      ? null  // handled below as DO NOTHING
      : conflictTarget === 'vin_number'
        ? `on conflict (vin_number) where vin_number is not null do update set`
        : `on conflict (${quoteIdentifier(conflictTarget)}) do update set`;

  const result = await client.query(
    onConflictSql === null
      ? `
      insert into ${table} (${insertColumns.map(quoteIdentifier).join(', ')})
      values ${rowGroups.join(',\n        ')}
      on conflict (vin_number) where vin_number is not null do nothing
      returning (xmax = 0) as inserted
    `
      : `
      insert into ${table} (${insertColumns.map(quoteIdentifier).join(', ')})
      values ${rowGroups.join(',\n        ')}
      ${onConflictSql}
        row_hash = excluded.row_hash,
        ${businessKeyUpdate}
        ${fullRowHashUpdate}
        ${updateSql},
        uploaded_at = excluded.uploaded_at
      returning (xmax = 0) as inserted
    `,
    values
  );

  let insertedCount = 0;
  let updatedCount = 0;
  for (const row of result.rows) {
    if (row.inserted) insertedCount += 1;
    else updatedCount += 1;
  }

  return { insertedCount, updatedCount, skippedExistingExactDuplicateCount };
}

async function insertBatch(client, tableName, columns, batch, uploadedAt, stats) {
  if (!batch.length) {
    return { insertedCount: 0, updatedCount: 0, skippedExistingExactDuplicateCount: 0 };
  }

  const usesBusinessKey = WARRANTY_TABLES.has(tableName);
  const usesExactRowDedupe = tableRequiresExactRowDedupe(tableName);
  const preparedRows = prepareBatchRows(
    tableName,
    columns,
    batch,
    uploadedAt,
    stats,
    usesBusinessKey,
    usesExactRowDedupe
  );

  if (!usesBusinessKey) {
    const conflictTarget = tableName === 'kia_stock_management'
      ? 'vin_number'          // delete+reinsert daily; upsert on conflict
      : tableName === 'kia_stock_report'
        ? 'vin_number_do_nothing'  // never delete; skip existing VINs
        : (usesExactRowDedupe ? 'full_row_hash' : 'row_hash');

    return upsertPreparedRows(
      client,
      tableName,
      columns,
      preparedRows,
      false,
      usesExactRowDedupe,
      conflictTarget
    );
  }

  const withBusinessKey = preparedRows.filter(row => row.businessIdentityKey);
  const withoutBusinessKey = preparedRows.filter(row => !row.businessIdentityKey);
  const businessResult = await upsertPreparedRows(
    client,
    tableName,
    columns,
    withBusinessKey,
    true,
    usesExactRowDedupe,
    'business_identity_key'
  );
  const rowHashResult = await upsertPreparedRows(
    client,
    tableName,
    columns,
    withoutBusinessKey,
    true,
    usesExactRowDedupe,
    'row_hash'
  );

  return {
    insertedCount: businessResult.insertedCount + rowHashResult.insertedCount,
    updatedCount: businessResult.updatedCount + rowHashResult.updatedCount,
    skippedExistingExactDuplicateCount:
      businessResult.skippedExistingExactDuplicateCount + rowHashResult.skippedExistingExactDuplicateCount
  };
}

export async function saveReportSheetToRelationalTable({
  sheetName,
  headers,
  rows,
  batchSize = 750
}) {
  if (!Array.isArray(headers) || !headers.length || !Array.isArray(rows)) {
    throw new Error('Relational save requires non-empty headers and rows array');
  }

  const tableName = normalizeTableName(sheetName);
  const columns = buildColumns(headers, rows);
  const uploadedAt = new Date().toISOString();
  const startedAt = Date.now();
  const effectiveBatchSize = Math.max(1, Math.min(batchSize, Math.floor(60000 / (columns.length + 2))));
  const seenBusinessKeys = new Set();
  const seenFullRowHashes = new Set();
  const uniqueRows = [];
  let skippedDuplicateIncomingRows = 0;
  const usesExactRowDedupe = tableRequiresExactRowDedupe(tableName);

  for (const row of rows) {
    const normalizedValues = columns.map(column => normalizeValue(row[column.header], column));
    const rowHash = rowSignatureFromNormalizedValues(columns, normalizedValues, tableName);
    const fullRowHash = usesExactRowDedupe
      ? buildFullRowHash(tableName, columns, normalizedValues)
      : null;
    const businessIdentityKey = WARRANTY_TABLES.has(tableName)
      ? buildBusinessIdentityKey(tableName, columns, normalizedValues)
      : null;

    if (usesExactRowDedupe) {
      if (!isEmpty(fullRowHash) && seenFullRowHashes.has(fullRowHash)) {
        skippedDuplicateIncomingRows += 1;
        continue;
      }
      if (!isEmpty(fullRowHash)) {
        seenFullRowHashes.add(fullRowHash);
      }
    } else if (businessIdentityKey) {
      if (seenBusinessKeys.has(businessIdentityKey)) {
        skippedDuplicateIncomingRows += 1;
        continue;
      }
      seenBusinessKeys.add(businessIdentityKey);
    } else if (seenFullRowHashes.has(rowHash)) {
      skippedDuplicateIncomingRows += 1;
      continue;
    } else {
      seenFullRowHashes.add(rowHash);
    }

    uniqueRows.push(row);
  }
  const stats = {
    invalidDates: 0,
    invalidNumerics: 0,
    invalidDateColumns: {},
    invalidNumericColumns: {}
  };

  return withPostgresClient(async client => {
    await client.query('SET statement_timeout = 0');
    await ensureReportTable(client, tableName, columns);
    const backfilledFullRowHashCount = await backfillExactRowHashes(client, tableName, columns);
    const removedExistingExactDuplicateCount = await removeExistingExactRowDuplicates(client, tableName);
    await ensureExactRowUniqueIndex(client, tableName);
    logger.info('Relational report table ready', {
      sheetName,
      tableName,
      columnCount: columns.length,
      columns: columns.map(column => ({ name: column.name, type: column.type })),
      exactRowDedupe: usesExactRowDedupe,
      backfilledFullRowHashCount,
      removedExistingExactDuplicateCount
    });

    let insertedRowCount = 0;
    let updatedRowCount = 0;
    let skippedExistingExactDuplicateCount = 0;
    let batchCount = 0;
    for (let index = 0; index < uniqueRows.length; index += effectiveBatchSize) {
      const batch = uniqueRows.slice(index, index + effectiveBatchSize);
      batchCount += 1;
      try {
        const batchResult = await insertBatch(client, tableName, columns, batch, uploadedAt, stats);
        insertedRowCount += batchResult.insertedCount;
        updatedRowCount += batchResult.updatedCount;
        skippedExistingExactDuplicateCount += batchResult.skippedExistingExactDuplicateCount ?? 0;
      } catch (error) {
        logger.error('Relational report batch insert failed', {
          sheetName,
          tableName,
          batch: batchCount,
          batchSize: batch.length,
          err: {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        });
        throw error;
      }
    }

    const duplicateRowCount = skippedDuplicateIncomingRows + skippedExistingExactDuplicateCount + updatedRowCount;
    logger.info('Relational report rows inserted', {
      sheetName,
      tableName,
      incomingRowCount: rows.length,
      uniqueIncomingRowCount: uniqueRows.length,
      skippedDuplicateIncomingRows,
      skippedExistingExactDuplicateCount,
      insertedRowCount,
      updatedRowCount,
      duplicateRowCount,
      batchCount,
      batchSize: effectiveBatchSize,
      durationMs: Date.now() - startedAt,
      invalidDates: stats.invalidDates,
      invalidNumerics: stats.invalidNumerics,
      invalidDateColumns: stats.invalidDateColumns,
      invalidNumericColumns: stats.invalidNumericColumns
    });

    return {
      tableName,
      incomingRowCount: rows.length,
      insertedRowCount,
      updatedRowCount,
      duplicateRowCount,
      skippedExistingExactDuplicateCount,
      batchCount,
      batchSize: effectiveBatchSize,
      durationMs: Date.now() - startedAt,
      invalidDates: stats.invalidDates,
      invalidNumerics: stats.invalidNumerics
    };
  });
}

export async function saveReportSheetToSupabaseRest({
  sheetName,
  headers,
  rows,
  batchSize = 500
}) {
  if (!Array.isArray(headers) || !headers.length || !Array.isArray(rows)) {
    throw new Error('Supabase REST save requires non-empty headers and rows array');
  }

  const tableName = normalizeTableName(sheetName);
  const columns = buildColumns(headers, rows);
  const uploadedAt = new Date().toISOString();
  const startedAt = Date.now();
  
  const seenIncomingRows = new Set();
  const uniqueRows = [];
  const stats = {
    invalidDates: 0,
    invalidNumerics: 0,
    invalidDateColumns: {},
    invalidNumericColumns: {}
  };
  
  for (const row of rows) {
    const normalizedValues = columns.map(column => normalizeValue(row[column.header], column, stats));
    const signature = rowSignatureFromNormalizedValues(columns, normalizedValues, tableName);
    if (seenIncomingRows.has(signature)) {
      continue;
    }
    seenIncomingRows.add(signature);
    uniqueRows.push(row);
  }
  
  const supabase = createSupabaseClient();
  let insertedRowCount = 0;
  let batchCount = 0;
  
  for (let index = 0; index < uniqueRows.length; index += batchSize) {
    const batch = uniqueRows.slice(index, index + batchSize);
    batchCount += 1;
    
    try {
      const insertData = batch.map(row => {
        const normalizedValues = columns.map(column => normalizeValue(row[column.header], column, stats));
        const rowValues = {
          row_hash: rowSignatureFromNormalizedValues(columns, normalizedValues, tableName),
          uploaded_at: uploadedAt
        };
        columns.forEach((column, colIndex) => {
          rowValues[column.name] = normalizedValues[colIndex];
        });
        return rowValues;
      });
      
      const { data, error } = await supabase
        .from(tableName)
        .upsert(insertData, { onConflict: 'row_hash', ignoreDuplicates: false })
        .select('row_hash');
      
      if (error) {
        if (error.code === '42P01') {
          logger.warn('Table does not exist, will try to create via first insert', { tableName });
        } else {
          logger.error('Supabase REST batch insert failed', {
            sheetName,
            tableName,
            batch: batchCount,
            batchSize: batch.length,
            err: { name: 'SupabaseError', message: error.message, code: error.code }
          });
        }
        throw error;
      }
      
      const batchInserted = data?.length || 0;
      insertedRowCount += batchInserted;
      logger.info('Supabase REST batch inserted', {
        sheetName,
        tableName,
        batch: batchCount,
        batchSize: batch.length,
        inserted: batchInserted
      });
    } catch (error) {
      logger.error('Supabase REST batch insert failed', {
        sheetName,
        tableName,
        batch: batchCount,
        batchSize: batch.length,
        err: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      });
      throw error;
    }
  }

  const duplicateRowCount = rows.length - insertedRowCount;
  logger.info('Supabase REST report rows inserted', {
    sheetName,
    tableName,
    incomingRowCount: rows.length,
    uniqueIncomingRowCount: uniqueRows.length,
    insertedRowCount,
    duplicateRowCount,
    batchCount,
    batchSize,
    durationMs: Date.now() - startedAt,
    invalidDates: stats.invalidDates,
    invalidNumerics: stats.invalidNumerics,
    invalidDateColumns: stats.invalidDateColumns,
    invalidNumericColumns: stats.invalidNumericColumns
  });

  return {
    tableName,
    incomingRowCount: rows.length,
    insertedRowCount,
    duplicateRowCount,
    batchCount,
    batchSize,
    durationMs: Date.now() - startedAt,
    invalidDates: stats.invalidDates,
    invalidNumerics: stats.invalidNumerics
  };
}

export async function clearRelationalTable(sheetName) {
  const tableName = normalizeTableName(sheetName);
  const table = quoteIdentifier(tableName);

  return withPostgresClient(async client => {
    const exists = await client.query(
      `select to_regclass($1) as regclass`,
      [`public.${tableName}`]
    );
    if (!exists.rows[0]?.regclass) {
      logger.info('Relational table clear skipped because table does not exist yet', {
        sheetName,
        tableName
      });
      return { tableName, cleared: false, previousRowCount: 0 };
    }

    const countResult = await client.query(`select count(*)::bigint as row_count from ${table}`);
    const previousRowCount = Number(countResult.rows[0]?.row_count ?? 0);
    await client.query(`truncate table ${table} restart identity`);
    logger.info('Relational table cleared', {
      sheetName,
      tableName,
      previousRowCount
    });
    return { tableName, cleared: true, previousRowCount };
  });
}
