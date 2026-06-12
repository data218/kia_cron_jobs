import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { quoteIdentifier, withPostgresClient } from './postgres.js';

const REPORT_TABLES = [
  'ro_billing_report',
  'kia_call_center_complaints',
  'open_ro_yearly',
  'hyundai_repair_order_list',
  'hyundai_ro_billing_report',
  'hyundai_call_center_complaints',
  'hyundai_customer_complaint_list',
  'hyundai_open_ro_yearly',
  'hyundai_demo_job_cards',
  'hyundai_demo_car_list',
  'hyundai_service_appointment',
  'hyundai_psf_yearly',
  'hyundai_ew_report',
  'hyundai_mcp_report',
  'hyundai_adv_wise_lubricants_vas',
  'hyundai_operation_wise_analysis_report',
  'trust_package',
  'am_platinum_repair_order_list',
  'am_platinum_ro_billing_report',
  'am_platinum_call_center_complaints',
  'am_platinum_customer_complaint_list',
  'am_platinum_open_ro_yearly',
  'am_platinum_demo_job_cards',
  'am_platinum_demo_car_list',
  'am_platinum_service_appointment',
  'am_platinum_psf_yearly',
  'am_platinum_ew_report',
  'am_platinum_mcp_report',
  'am_platinum_adv_wise_lubricants_vas',
  'am_platinum_operation_wise_analysis_report',
  'am_platinum_trust_package',
  'demo_job_cards',
  'demo_car_list',
  'service_appointment',
  'psf_yearly',
  'ew_report',
  'mcp_report',
  'adv_wise_lubricants_vas',
  'operation_wise_analysis_report',
  'operation_wise_analysis_advisor_report',
  'rsa_report'
];

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
const BATCH_SIZE = 500;

function hashDataObject(data) {
  return hashDataObjectForTable(null, data);
}

function hashDataObjectForTable(tableName, data) {
  const identityGroups = identityGroupsForTable(tableName);
  for (const group of identityGroups) {
    const entries = group
      .map(columnName => [columnName, data?.[columnName]])
      .filter(([, value]) => value != null && String(value).trim() !== '');

    if (entries.length === group.length) {
      return crypto
        .createHash('sha256')
        .update(JSON.stringify([['__table', tableName], ...entries]))
        .digest('hex');
    }
  }

  const entries = Object.entries(data ?? {})
    .filter(([key]) => !NON_BUSINESS_HASH_COLUMNS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex');
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

function sortRowsForKeep(left, right) {
  const leftUploaded = left.uploaded_at ? new Date(left.uploaded_at).getTime() : 0;
  const rightUploaded = right.uploaded_at ? new Date(right.uploaded_at).getTime() : 0;
  if (rightUploaded !== leftUploaded) return rightUploaded - leftUploaded;
  return Number(right.id) - Number(left.id);
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

async function deleteRows(client, tableName, ids) {
  if (!ids.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const batch = ids.slice(index, index + BATCH_SIZE);
    await client.query(`delete from ${table} where id = any($1::bigint[])`, [batch]);
  }
}

async function updateTemporaryHashes(client, tableName, rows) {
  if (!rows.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await client.query(
      `
        update ${table} as target
        set row_hash = source.temp_hash
        from jsonb_to_recordset($1::jsonb) as source(id bigint, temp_hash text)
        where target.id = source.id
      `,
      [JSON.stringify(batch.map(row => ({
        id: row.id,
        temp_hash: `rehash-temp:${row.id}:${row.newHash}`
      })))]
    );
  }
}

async function updateFinalHashes(client, tableName, rows) {
  if (!rows.length) return;

  const table = `public.${quoteIdentifier(tableName)}`;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await client.query(
      `
        update ${table} as target
        set row_hash = source.row_hash
        from jsonb_to_recordset($1::jsonb) as source(id bigint, row_hash text)
        where target.id = source.id
      `,
      [JSON.stringify(batch.map(row => ({
        id: row.id,
        row_hash: row.newHash
      })))]
    );
  }
}

export async function dedupeRelationalTables({ tables = REPORT_TABLES } = {}) {
  return withPostgresClient(async client => {
    const summaries = [];

    for (const tableName of tables) {
      if (!(await tableExists(client, tableName))) {
        logger.warn('Skipping relational table dedupe because table does not exist', { tableName });
        continue;
      }

      const startedAt = Date.now();
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

      const hashGroups = new Map();
      for (const row of result.rows) {
        const newHash = hashDataObjectForTable(tableName, row.data);
        const prepared = {
          id: row.id,
          oldHash: row.row_hash,
          uploaded_at: row.uploaded_at,
          newHash
        };
        const group = hashGroups.get(newHash) ?? [];
        group.push(prepared);
        hashGroups.set(newHash, group);
      }

      const rowsToKeep = [];
      const idsToDelete = [];
      let duplicateGroups = 0;

      for (const group of hashGroups.values()) {
        group.sort(sortRowsForKeep);
        rowsToKeep.push(group[0]);
        if (group.length > 1) {
          duplicateGroups += 1;
          idsToDelete.push(...group.slice(1).map(row => row.id));
        }
      }

      await deleteRows(client, tableName, idsToDelete);
      await updateTemporaryHashes(client, tableName, rowsToKeep);
      await updateFinalHashes(client, tableName, rowsToKeep);

      const summary = {
        tableName,
        scannedRowCount: result.rowCount,
        duplicateGroups,
        deletedDuplicateRowCount: idsToDelete.length,
        retainedRowCount: rowsToKeep.length,
        durationMs: Date.now() - startedAt
      };
      summaries.push(summary);
      logger.info('Relational table dedupe completed', summary);
    }

    return summaries;
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
}

if (isMainModule()) {
  dedupeRelationalTables()
    .then(summaries => {
      console.log(JSON.stringify(summaries, null, 2));
    })
    .catch(error => {
      logger.error('Relational table dedupe failed', error);
      process.exitCode = 1;
    });
}
