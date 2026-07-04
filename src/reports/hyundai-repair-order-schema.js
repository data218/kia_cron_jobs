export const HYUNDAI_REPAIR_ORDER_CANONICAL_HEADERS = [
  'No.',
  'R/O No',
  'R/O Date',
  'R/O Status',
  'Reg. No',
  'VIN',
  'Vehicle Type',
  'Night Service',
  'Model',
  'Sale Date',
  'Work Type',
  'Svc Adv.',
  'Tech. Name',
  'UC Category',
  'HIIB Y/N',
  'Mobile Service',
  'Special Message',
  'RO Source',
  'High Risk Customer',
  'Quick Service Status',
  'DLR NO',
  'Visit Type',
  'Visit Count'
];

export const HYUNDAI_REPAIR_ORDER_CANONICAL_COLUMNS = [
  'no',
  'r_o_no',
  'r_o_date',
  'r_o_status',
  'reg_no',
  'vin',
  'vehicle_type',
  'night_service',
  'model',
  'sale_date',
  'work_type',
  'svc_adv',
  'tech_name',
  'uc_category',
  'hiib_y_n',
  'mobile_service',
  'special_message',
  'ro_source',
  'high_risk_customer',
  'quick_service_status',
  'dlr_no',
  'visit_type',
  'visit_count'
];

const HYUNDAI_REPAIR_ORDER_ALIASES = {
  'No.': ['No.', 'No', 'S NO', 'S No', 'S.No', 'no', 's_no'],
  'R/O No': ['R/O No', 'RO No', 'r_o_no', 'ro_no'],
  'R/O Date': ['R/O Date', 'RO Date', 'r_o_date', 'ro_date'],
  'R/O Status': ['R/O Status', 'Status', 'New R/O status', 'r_o_status', 'status', 'new_r_o_status'],
  'Reg. No': ['Reg. No', 'Reg No', 'reg_no'],
  VIN: ['VIN', 'VIN No.', 'VIN No', 'vin'],
  'Vehicle Type': ['Vehicle Type', 'vehicle_type'],
  'Night Service': ['Night Service', 'night_service'],
  Model: ['Model', 'model'],
  'Sale Date': ['Sale Date', 'sale_date'],
  'Work Type': ['Work Type', 'work_type'],
  'Svc Adv.': ['Svc Adv.', 'Service Adv.', 'Service Advisor', 'svc_adv', 'service_adv'],
  'Tech. Name': ['Tech. Name', 'Main Technician', 'Technician Name', 'tech_name', 'man_tech', 'main_technician'],
  'UC Category': ['UC Category', 'uc_category'],
  'HIIB Y/N': ['HIIB Y/N', 'hiib_y_n'],
  'Mobile Service': ['Mobile Service', 'mobile_service'],
  'Special Message': ['Special Message', 'Special Msg.', 'Special Msg', 'special_message', 'special_msg'],
  'RO Source': ['RO Source', 'Source Of RO', 'ro_source', 'source_of_ro'],
  'High Risk Customer': ['High Risk Customer', 'high_risk_customer'],
  'Quick Service Status': ['Quick Service Status', 'quick_service_status'],
  'DLR NO': ['DLR NO', 'Dealer', 'Dealer Code', 'Sale Dealer Code', 'dealer_code', 'source_dealer_code', 'sale_dealer_code', 'dealer', 'dlr_no'],
  'Visit Type': ['Visit Type', 'visit Type', 'visit_type'],
  'Visit Count': ['Visit Count', 'visit_count']
};

const HEADER_TO_COLUMN = Object.fromEntries(
  HYUNDAI_REPAIR_ORDER_CANONICAL_HEADERS.map((header, index) => [header, HYUNDAI_REPAIR_ORDER_CANONICAL_COLUMNS[index]])
);

function normalizeText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function lookupFirstValue(row, aliases) {
  for (const alias of aliases) {
    if (!Object.prototype.hasOwnProperty.call(row ?? {}, alias)) {
      continue;
    }

    const value = normalizeText(row[alias]);
    if (value) {
      return value;
    }
  }

  return '';
}

function normalizeDealerCode(value, fallbackDealerCode) {
  const dealerCode = normalizeText(value || fallbackDealerCode);
  return dealerCode ? dealerCode.toUpperCase() : '';
}

export function normalizeHyundaiRepairOrderRow(row, { dealerCode = '' } = {}) {
  const normalized = {};

  for (const header of HYUNDAI_REPAIR_ORDER_CANONICAL_HEADERS) {
    const aliases = HYUNDAI_REPAIR_ORDER_ALIASES[header] ?? [header];
    const value = lookupFirstValue(row, aliases);

    if (header === 'DLR NO') {
      normalized[header] = normalizeDealerCode(value, dealerCode);
      continue;
    }

    normalized[header] = value;
  }

  return normalized;
}

export function hyundaiRepairOrderRowToDatabaseRow(row, options = {}) {
  const canonicalRow = normalizeHyundaiRepairOrderRow(row, options);
  return Object.fromEntries(
    HYUNDAI_REPAIR_ORDER_CANONICAL_HEADERS.map(header => [
      HEADER_TO_COLUMN[header],
      canonicalRow[header]
    ])
  );
}

export function normalizeHyundaiRepairOrderDataset(merged, { dealerCode = '' } = {}) {
  const rows = (merged?.rows ?? []).map(row => normalizeHyundaiRepairOrderRow(row, { dealerCode }));

  return {
    headers: [...HYUNDAI_REPAIR_ORDER_CANONICAL_HEADERS],
    rows
  };
}
