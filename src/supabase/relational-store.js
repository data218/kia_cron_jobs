import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { quoteIdentifier, withPostgresClient } from './postgres.js';
import {
  NON_BUSINESS_HASH_COLUMNS,
  WARRANTY_TABLES,
  identityGroupsForTable,
  resolveBusinessIdentityKey
} from './row-identity.js';

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
const RESERVED_COLUMNS = new Set(['id', 'row_hash', 'uploaded_at']);
const IDENTITY_COLUMN_ALIASES = {
  claim_no: ['claim_no', 'claim_number', 'warranty_claim_no'],
  r_o_no: ['r_o_no', 'ro_no'],
  claim_type: ['claim_type', 'warranty_claim_type'],
  claim_date: ['claim_date', 'warranty_claim_date'],
  ro_date: ['ro_date', 'r_o_date']
};

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

async function ensureReportTable(client, tableName, columns) {
  const signature = `${tableName}:${columns.map(column => `${column.name}:${column.type}`).join('|')}`;
  if (ensuredTableSignatures.has(signature)) {
    return;
  }
  const table = `public.${quoteIdentifier(tableName)}`;
  const columnSql = columns
    .map(column => `${quoteIdentifier(column.name)} ${columnSqlType(column.type)}`)
    .join(',\n          ');

  await client.query(`
    create table if not exists ${table} (
      id bigserial primary key,
      row_hash text unique not null,
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

  await client.query(`
    alter table ${table}
    add column if not exists row_hash text
  `);
  await client.query(`
    alter table ${table}
    add column if not exists uploaded_at timestamptz default now()
  `);
  await client.query(`
    create unique index if not exists ${quoteIdentifier(`idx_${tableName}_row_hash`)}
    on ${table}(row_hash)
  `);

  const indexColumns = columns
    .map(column => column.name)
    .filter(columnName => IMPORTANT_INDEX_COLUMNS.has(columnName) || columnName.endsWith('_date'));

  for (const columnName of [...new Set([...indexColumns, 'uploaded_at'])]) {
    await client.query(`
      create index if not exists ${quoteIdentifier(`idx_${tableName}_${columnName}`)}
      on ${table}(${quoteIdentifier(columnName)})
    `);
  }

  if (WARRANTY_TABLES.has(tableName)) {
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

function sqlParamCast(columnIndex, columnCount, usesBusinessKey, column) {
  if (columnIndex === 0) return '::text';
  if (usesBusinessKey && columnIndex === 1) return '::text';
  if (columnIndex === columnCount - 1) return '::timestamptz';
  if (column?.type === 'date') return '::date';
  if (column?.type === 'numeric') return '::numeric';
  return '::text';
}

function prepareBatchRows(tableName, columns, batch, uploadedAt, stats, usesBusinessKey) {
  return batch.map(row => {
    const normalizedValues = columns.map(column => normalizeValue(row[column.header], column, stats));
    const rowHash = rowSignatureFromNormalizedValues(columns, normalizedValues, tableName);
    const businessIdentityKey = usesBusinessKey
      ? buildBusinessIdentityKey(tableName, columns, normalizedValues)
      : null;
    const rowValues = usesBusinessKey
      ? [rowHash, businessIdentityKey, ...normalizedValues, uploadedAt]
      : [rowHash, ...normalizedValues, uploadedAt];

    return { rowHash, businessIdentityKey, rowValues };
  });
}

async function upsertPreparedRows(client, tableName, columns, preparedRows, usesBusinessKey, conflictTarget) {
  if (!preparedRows.length) {
    return { insertedCount: 0, updatedCount: 0 };
  }

  const table = `public.${quoteIdentifier(tableName)}`;
  const insertColumns = usesBusinessKey
    ? ['row_hash', 'business_identity_key', ...columns.map(column => column.name), 'uploaded_at']
    : ['row_hash', ...columns.map(column => column.name), 'uploaded_at'];
  const values = [];
  const rowGroups = [];
  let paramIndex = 1;

  for (const { rowValues } of preparedRows) {
    const placeholders = rowValues.map((value, columnIndex) => {
      const column = usesBusinessKey
        ? (columnIndex <= 1 ? null : columns[columnIndex - 2])
        : (columnIndex === 0 ? null : columns[columnIndex - 1]);
      const placeholder = `$${paramIndex}${sqlParamCast(columnIndex, rowValues.length, usesBusinessKey, column)}`;
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

  const onConflictSql = conflictTarget === 'business_identity_key'
    ? `on conflict (${quoteIdentifier(conflictTarget)}) where business_identity_key is not null do update set`
    : `on conflict (${quoteIdentifier(conflictTarget)}) do update set`;

  const result = await client.query(
    `
      insert into ${table} (${insertColumns.map(quoteIdentifier).join(', ')})
      values ${rowGroups.join(',\n        ')}
      ${onConflictSql}
        row_hash = excluded.row_hash,
        ${businessKeyUpdate}
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

  return { insertedCount, updatedCount };
}

async function insertBatch(client, tableName, columns, batch, uploadedAt, stats) {
  if (!batch.length) {
    return { insertedCount: 0, updatedCount: 0 };
  }

  const usesBusinessKey = WARRANTY_TABLES.has(tableName);
  const preparedRows = prepareBatchRows(tableName, columns, batch, uploadedAt, stats, usesBusinessKey);

  if (!usesBusinessKey) {
    return upsertPreparedRows(client, tableName, columns, preparedRows, false, 'row_hash');
  }

  const withBusinessKey = preparedRows.filter(row => row.businessIdentityKey);
  const withoutBusinessKey = preparedRows.filter(row => !row.businessIdentityKey);
  const businessResult = await upsertPreparedRows(
    client,
    tableName,
    columns,
    withBusinessKey,
    true,
    'business_identity_key'
  );
  const rowHashResult = await upsertPreparedRows(
    client,
    tableName,
    columns,
    withoutBusinessKey,
    true,
    'row_hash'
  );

  return {
    insertedCount: businessResult.insertedCount + rowHashResult.insertedCount,
    updatedCount: businessResult.updatedCount + rowHashResult.updatedCount
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

  for (const row of rows) {
    const normalizedValues = columns.map(column => normalizeValue(row[column.header], column));
    const rowHash = rowSignatureFromNormalizedValues(columns, normalizedValues, tableName);
    const businessIdentityKey = WARRANTY_TABLES.has(tableName)
      ? buildBusinessIdentityKey(tableName, columns, normalizedValues)
      : null;

    if (businessIdentityKey) {
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
    logger.info('Relational report table ready', {
      sheetName,
      tableName,
      columnCount: columns.length,
      columns: columns.map(column => ({ name: column.name, type: column.type }))
    });

    let insertedRowCount = 0;
    let updatedRowCount = 0;
    let batchCount = 0;
    for (let index = 0; index < uniqueRows.length; index += effectiveBatchSize) {
      const batch = uniqueRows.slice(index, index + effectiveBatchSize);
      batchCount += 1;
      try {
        const batchResult = await insertBatch(client, tableName, columns, batch, uploadedAt, stats);
        insertedRowCount += batchResult.insertedCount;
        updatedRowCount += batchResult.updatedCount;
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

    const duplicateRowCount = skippedDuplicateIncomingRows + updatedRowCount;
    logger.info('Relational report rows inserted', {
      sheetName,
      tableName,
      incomingRowCount: rows.length,
      uniqueIncomingRowCount: uniqueRows.length,
      skippedDuplicateIncomingRows,
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
      batchCount,
      batchSize: effectiveBatchSize,
      durationMs: Date.now() - startedAt,
      invalidDates: stats.invalidDates,
      invalidNumerics: stats.invalidNumerics
    };
  });
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
