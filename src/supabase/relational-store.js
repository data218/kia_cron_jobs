import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { quoteIdentifier, withPostgresClient } from './postgres.js';

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
  'work_type',
  'appointment_date',
  'appointement_date',
  'booking_date',
  'uploaded_at'
]);
const RESERVED_COLUMNS = new Set(['id', 'row_hash', 'uploaded_at']);
const NON_BUSINESS_HASH_COLUMNS = new Set([
  'id',
  'row_hash',
  'uploaded_at',
  's_no',
  'sno',
  'sr_no',
  'serial_no',
  'sl_no',
  'no'
]);
const TABLE_IDENTITY_COLUMNS = {
  ro_billing_report: [
    ['dealer_code', 'bill_no'],
    ['bill_no'],
    ['dealer_code', 'ro_no', 'bill_date'],
    ['ro_no', 'bill_date', 'vin']
  ],
  kia_call_center_complaints: [
    ['complaint_no', 'sr_no'],
    ['complaint_no']
  ],
  open_ro_yearly: [
    ['dealer_code', 'r_o_no'],
    ['r_o_no'],
    ['vin', 'ro_date', 'work_type']
  ],
  hyundai_repair_order_list: [
    ['dealer_code', 'r_o_no'],
    ['r_o_no'],
    ['vin', 'ro_date', 'work_type']
  ],
  hyundai_ro_billing_report: [
    ['source_dealer_code', 'bill_no'],
    ['dealer_code', 'bill_no'],
    ['bill_no'],
    ['source_dealer_code', 'ro_no', 'bill_date'],
    ['dealer_code', 'ro_no', 'bill_date'],
    ['ro_no', 'bill_date', 'vin']
  ],
  hyundai_call_center_complaints: [
    ['source_dealer_code', 'complaint_no', 'sr_no'],
    ['complaint_no', 'sr_no'],
    ['complaint_no']
  ],
  hyundai_customer_complaint_list: [
    ['source_dealer_code', 'complaint_no', 'sr_no'],
    ['source_dealer_code', 'complaint_no'],
    ['complaint_no', 'sr_no'],
    ['complaint_no']
  ],
  hyundai_open_ro_yearly: [
    ['source_dealer_code', 'r_o_no'],
    ['dealer_code', 'r_o_no'],
    ['r_o_no'],
    ['vin', 'ro_date', 'work_type']
  ],
  hyundai_demo_job_cards: [
    ['source_dealer_code', 'r_o_no'],
    ['dealer_code', 'r_o_no'],
    ['r_o_no'],
    ['vin', 'ro_date', 'work_type']
  ],
  hyundai_demo_car_list: [
    ['source_dealer_code', 'vin'],
    ['vin'],
    ['vin_no'],
    ['chassis_no'],
    ['vin_chassis_no'],
    ['vin_chasis_no'],
    ['invoice_no', 'vin'],
    ['invoice_no', 'chassis_no'],
    ['purchase_invoice_no']
  ],
  hyundai_service_appointment: [
    ['source_dealer_code', 'a_t_no'],
    ['source_dealer_code', 'appointment_no'],
    ['source_dealer_code', 'booking_no'],
    ['dealer_code', 'a_t_no'],
    ['dealer_code', 'appointment_no'],
    ['dealer_code', 'booking_no'],
    ['appointment_no'],
    ['booking_no'],
    ['source_dealer_code', 'vin', 'appointment_date', 'appointment_time'],
    ['source_dealer_code', 'vin_no', 'appointment_date', 'appointment_time'],
    ['source_dealer_code', 'vehicle_reg_no', 'appointment_date', 'appointment_time'],
    ['source_dealer_code', 'reg_no', 'appointment_date', 'appointment_time'],
    ['vin', 'appointment_date', 'appointment_time'],
    ['vin_no', 'appointment_date', 'appointment_time'],
    ['vehicle_reg_no', 'appointment_date', 'appointment_time'],
    ['reg_no', 'appointment_date', 'appointment_time']
  ],
  hyundai_psf_yearly: [
    ['source_dealer_code', 'ro_no'],
    ['ro_no'],
    ['vin', 'ro_date', 'visit_type']
  ],
  hyundai_ew_report: [
    ['source_dealer_code', 'certi_no'],
    ['certi_no'],
    ['vin', 'reg_date', 'scheme_desc']
  ],
  hyundai_mcp_report: [
    ['source_dealer_code', 'cert_no'],
    ['source_dealer_code', 'vin', 'package_purchase_date', 'package_name'],
    ['dealer_code', 'cert_no'],
    ['dealer_code', 'vin', 'package_purchase_date', 'package_name'],
    ['cert_no'],
    ['vin', 'package_purchase_date', 'package_name']
  ],
  hyundai_adv_wise_lubricants_vas: [
    ['source_dealer_code', 'gst_invoice_no', 'op_part_code', 'vin_no'],
    ['source_dealer_code', 'invoice_no', 'op_part_code', 'vin_no'],
    ['source_dealer_code', 'ro_no', 'op_part_code', 'vin_no'],
    ['gst_invoice_no', 'op_part_code', 'vin_no'],
    ['invoice_no', 'op_part_code', 'vin_no'],
    ['ro_no', 'op_part_code', 'vin_no']
  ],
  hyundai_operation_wise_analysis_report: [
    ['report_type', 'source_dealer_code', 'op_part_code'],
    ['report_type', 'source_dealer_code', 'report_period_start', 'report_period_end', 'op_part_code'],
    ['report_type', 'source_dealer_code', 'report_month', 'op_part_code']
  ],
  trust_package: [
    ['trust_package_section', 'source_dealer_code', 'cert_no'],
    ['trust_package_section', 'source_dealer_code', 'certi_no'],
    ['trust_package_section', 'source_dealer_code', 'certificate_no'],
    ['trust_package_section', 'source_dealer_code', 'scheme_no', 'vin'],
    ['trust_package_section', 'source_dealer_code', 'vin', 'reg_date'],
    ['trust_package_section', 'cert_no'],
    ['trust_package_section', 'certi_no'],
    ['trust_package_section', 'certificate_no'],
    ['trust_package_section', 'vin', 'reg_date']
  ],
  demo_job_cards: [
    ['dealer_code', 'r_o_no'],
    ['r_o_no'],
    ['vin', 'ro_date', 'work_type']
  ],
  demo_car_list: [
    ['vin'],
    ['vin_no'],
    ['chassis_no'],
    ['vin_chassis_no'],
    ['vin_chasis_no'],
    ['invoice_no', 'vin'],
    ['invoice_no', 'chassis_no'],
    ['purchase_invoice_no']
  ],
  service_appointment: [
    ['dealer_code', 'a_t_no'],
    ['dealer_code', 'a_t_date_time', 'vin'],
    ['dealer_code', 'a_t_date_time', 'reg_no'],
    ['dealer_code', 'appointment_no'],
    ['dealer_code', 'booking_no'],
    ['appointment_no'],
    ['booking_no'],
    ['dealer_code', 'vin', 'appointment_date', 'appointment_time'],
    ['dealer_code', 'vin_no', 'appointment_date', 'appointment_time'],
    ['dealer_code', 'vehicle_reg_no', 'appointment_date', 'appointment_time'],
    ['dealer_code', 'reg_no', 'appointment_date', 'appointment_time'],
    ['vin', 'appointment_date', 'appointment_time'],
    ['vin_no', 'appointment_date', 'appointment_time'],
    ['vehicle_reg_no', 'appointment_date', 'appointment_time'],
    ['reg_no', 'appointment_date', 'appointment_time'],
    ['mobile_no', 'appointment_date', 'customer_name'],
    ['mobile_no', 'appointement_date', 'customer_name'],
    ['dealer_code', 'customer_name', 'booking_date']
  ],
  psf_yearly: [
    ['ro_no'],
    ['vin', 'ro_date', 'visit_type']
  ],
  ew_report: [
    ['certi_no'],
    ['vin', 'reg_date', 'scheme_desc']
  ],
  mcp_report: [
    ['dealer_code', 'cert_no'],
    ['dealer_code', 'vin', 'package_purchase_date', 'package_name'],
    ['cert_no'],
    ['vin', 'package_purchase_date', 'package_name']
  ],
  rsa_report: [
    ['invoice_no', 'vin_chasis_no'],
    ['invoice_no'],
    ['vin_chasis_no', 'invoice_date', 'policy_name']
  ],
  adv_wise_lubricants_vas: [
    ['gst_invoice_no', 'op_part_code', 'vin_no'],
    ['invoice_no', 'op_part_code', 'vin_no'],
    ['ro_no', 'op_part_code', 'vin_no'],
    ['gst_invoice_no', 'labour_code', 'vin_no'],
    ['gst_invoice_no', 'part_no', 'vin_no']
  ],
  operation_wise_analysis_report: [
    ['report_type', 'report_period_start', 'report_period_end', 'dealer_code', 'op_part_code'],
    ['report_type', 'report_month', 'dealer_code', 'op_part_code']
  ],
  operation_wise_analysis_advisor_report: [
    ['report_type', 'date_type', 'service_advisor', 'report_period_start', 'report_period_end', 'dealer_code', 'op_part_code'],
    ['report_type', 'service_advisor', 'report_month', 'dealer_code', 'op_part_code']
  ]
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

function headerLooksNumeric(header) {
  const normalized = normalizeSqlName(header);
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
        const index = columns.findIndex(column => column.name === columnName);
        return index >= 0 ? [columnName, normalizedValues[index]] : null;
      })
      .filter(entry => entry && !isEmpty(entry[1]));

    if (entries.length === group.length) {
      return [['__table', tableName], ...entries];
    }
  }

  return null;
}

function identityGroupsForTable(tableName) {
  if (TABLE_IDENTITY_COLUMNS[tableName]) {
    return TABLE_IDENTITY_COLUMNS[tableName];
  }

  if (tableName.startsWith('am_platinum_')) {
    const suffix = tableName.slice('am_platinum_'.length);
    return TABLE_IDENTITY_COLUMNS[`hyundai_${suffix}`] ??
      TABLE_IDENTITY_COLUMNS[suffix] ??
      [];
  }

  return [];
}

export function rowSignature(row) {
  return hashEntries(normalizedRowEntries(row));
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

async function ensureReportTable(client, tableName, columns) {
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
}

async function insertBatch(client, tableName, columns, batch, uploadedAt, stats) {
  if (!batch.length) return 0;

  const table = `public.${quoteIdentifier(tableName)}`;
  const insertColumns = ['row_hash', ...columns.map(column => column.name), 'uploaded_at'];
  const values = [];
  const placeholders = [];

  batch.forEach((row, rowIndex) => {
    const normalizedValues = columns.map(column => normalizeValue(row[column.header], column, stats));
    const rowValues = [
      rowSignatureFromNormalizedValues(columns, normalizedValues, tableName),
      ...normalizedValues,
      uploadedAt
    ];
    const rowPlaceholders = rowValues.map((value, columnIndex) => {
      values.push(value);
      return `$${rowIndex * insertColumns.length + columnIndex + 1}`;
    });
    placeholders.push(`(${rowPlaceholders.join(', ')})`);
  });

  const updateSql = columns
    .map(column => `${quoteIdentifier(column.name)} = excluded.${quoteIdentifier(column.name)}`)
    .join(',\n        ');

  const result = await client.query(
    `
      insert into ${table} (${insertColumns.map(quoteIdentifier).join(', ')})
      values ${placeholders.join(',\n             ')}
      on conflict (row_hash) do update set
        ${updateSql},
        uploaded_at = excluded.uploaded_at
      returning (xmax = 0) as inserted
    `,
    values
  );

  return result.rows.filter(row => row.inserted).length;
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
  const seenIncomingRows = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    const normalizedValues = columns.map(column => normalizeValue(row[column.header], column));
    const signature = rowSignatureFromNormalizedValues(columns, normalizedValues, tableName);
    if (seenIncomingRows.has(signature)) {
      continue;
    }
    seenIncomingRows.add(signature);
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
    let batchCount = 0;
    for (let index = 0; index < uniqueRows.length; index += effectiveBatchSize) {
      const batch = uniqueRows.slice(index, index + effectiveBatchSize);
      batchCount += 1;
      try {
        insertedRowCount += await insertBatch(client, tableName, columns, batch, uploadedAt, stats);
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

    const duplicateRowCount = rows.length - insertedRowCount;
    logger.info('Relational report rows inserted', {
      sheetName,
      tableName,
      incomingRowCount: rows.length,
      uniqueIncomingRowCount: uniqueRows.length,
      insertedRowCount,
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
      duplicateRowCount,
      batchCount,
      batchSize: effectiveBatchSize,
      durationMs: Date.now() - startedAt,
      invalidDates: stats.invalidDates,
      invalidNumerics: stats.invalidNumerics
    };
  });
}
