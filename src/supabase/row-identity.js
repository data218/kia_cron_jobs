import crypto from 'node:crypto';

export const NON_BUSINESS_HASH_COLUMNS = new Set([
  'id',
  'row_hash',
  'uploaded_at',
  's_no',
  'sno',
  'sr_no',
  'serial_no',
  'sl_no',
  'no',
  'source_login_id'
]);

export const TABLE_IDENTITY_COLUMNS = {
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
  hyundai_warranty_claim_ytp: [
    ['source_login_id', 'source_dealer_code', 'claim_no'],
    ['source_login_id', 'source_dealer_code', 'r_o_no', 'claim_type', 'ro_date'],
    ['source_login_id', 'source_dealer_code', 'r_o_no', 'claim_type', 'claim_date'],
    ['source_dealer_code', 'claim_no'],
    ['claim_no'],
    ['r_o_no', 'claim_type', 'claim_date'],
    ['r_o_no', 'claim_type', 'ro_date']
  ],
  hyundai_warranty_claim_list: [
    ['source_login_id', 'source_dealer_code', 'claim_no'],
    ['source_login_id', 'source_dealer_code', 'r_o_no', 'claim_type', 'claim_date'],
    ['source_login_id', 'source_dealer_code', 'r_o_no', 'claim_date'],
    ['source_dealer_code', 'claim_no'],
    ['claim_no'],
    ['r_o_no', 'claim_type', 'claim_date'],
    ['r_o_no', 'claim_date']
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

export const AM_PLATINUM_TABLES = [
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
  'am_platinum_trust_package'
];

export function identityGroupsForTable(tableName) {
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

export function normalizeIdentityValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text.toLowerCase();
}

export function resolveBusinessIdentityKey(tableName, data) {
  const identityGroups = identityGroupsForTable(tableName);
  for (const group of identityGroups) {
    const entries = group
      .map(columnName => [columnName, normalizeIdentityValue(data?.[columnName])])
      .filter(([, value]) => value != null);

    if (entries.length === group.length) {
      return [
        tableName,
        ...entries.map(([columnName, value]) => `${columnName}=${value}`)
      ].join('|');
    }
  }

  return null;
}

export function fullRowContentHash(tableName, data) {
  const entries = Object.entries(data ?? {})
    .filter(([key]) => !NON_BUSINESS_HASH_COLUMNS.has(key))
    .map(([key, value]) => [key, normalizeIdentityValue(value)])
    .filter(([, value]) => value != null)
    .sort(([left], [right]) => left.localeCompare(right));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify([['__table', tableName], ...entries]))
    .digest('hex');
}

export const WARRANTY_TABLES = new Set([
  'hyundai_warranty_claim_list',
  'hyundai_warranty_claim_ytp'
]);

export function hashDataObjectForTable(tableName, data) {
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

export function sortRowsForKeep(left, right) {
  const leftUploaded = left.uploaded_at ? new Date(left.uploaded_at).getTime() : 0;
  const rightUploaded = right.uploaded_at ? new Date(right.uploaded_at).getTime() : 0;
  if (rightUploaded !== leftUploaded) return rightUploaded - leftUploaded;
  return Number(right.id) - Number(left.id);
}

export function groupRowsByIdentityHash(tableName, rows) {
  const hashGroups = new Map();

  for (const row of rows) {
    const newHash = hashDataObjectForTable(tableName, row.data);
    const prepared = {
      id: row.id,
      oldHash: row.row_hash,
      uploaded_at: row.uploaded_at,
      newHash,
      data: row.data
    };
    const group = hashGroups.get(newHash) ?? [];
    group.push(prepared);
    hashGroups.set(newHash, group);
  }

  const rowsToKeep = [];
  const idsToDelete = [];
  const duplicateGroups = [];

  for (const [identityHash, group] of hashGroups.entries()) {
    group.sort(sortRowsForKeep);
    rowsToKeep.push(group[0]);
    if (group.length > 1) {
      duplicateGroups.push({
        identityHash,
        keepId: group[0].id,
        deleteIds: group.slice(1).map(row => row.id),
        sample: group[0].data
      });
      idsToDelete.push(...group.slice(1).map(row => row.id));
    }
  }

  return {
    rowsToKeep,
    idsToDelete,
    duplicateGroups,
    duplicateGroupCount: duplicateGroups.length
  };
}
