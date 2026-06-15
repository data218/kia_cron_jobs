import { config } from '../config.js';
import { createGdmsAccountProfile } from '../accounts/gdms-account-profile.js';
import {
  openAdvWiseLubricantsVasReport,
  openDemoCarListReport,
  openEwReport,
  openMcpReport,
  openPsfYearlyReport,
  openRoBillingReport
} from '../navigation/kia-menu.js';
import {
  openHmilCallCenterComplaintServiceList,
  openHmilCustomerComplaintList,
  openHmilExtendedWarrantyList,
  openHmilOperationWiseAnalysisReport,
  openHmilPurchaseReport,
  openHmilRepairOrderListReport,
  openHmilServiceBookingListReport,
  openHmilTrustPackageSection
} from '../navigation/hmil-menu.js';
import { downloadHyundaiRepairOrderListReport } from './hyundai-repair-order-list.js';
import { runAmPlatinumOperationWiseForDealer } from './am-platinum-operation-wise-export.js';
import { createHyundaiKiaCloneReport } from './hyundai-kia-clone.js';

const COMPLAINT_EXPORT_HEADERS = [
  'No.',
  'Status',
  'Complaint No.',
  'SR No.',
  'Type',
  'Cust Name',
  'Mobile No.',
  'VIN No.',
  'Dealer Name',
  'Dealer Code',
  'Region',
  'Complaint Date',
  'Pending Days',
  'CC Reopen Days',
  'CC Reopen Date',
  'Hold Days',
  'Hold Status',
  'Dealer Resolving Date',
  'Resolving Date',
  'Resolved By Dealer',
  'Close Date',
  'Complaint Closing Time',
  'RCA Date',
  'Closed By',
  'Closed By Name',
  'Complaint Sub Source',
  'Complaint Remarks',
  'Service Engineer/Advisor Observation',
  'Complaint Type',
  'SR Area',
  'SR Sub Area',
  'SR Type',
  'Vehicle Model',
  'Varient',
  'Part Number',
  'Order Number',
  'Order Date',
  'Dealer SR Area',
  'Dealer SR Sub Area',
  'Delaer SR Type',
  'ASFM SR Area',
  'ASFM SR Sub Area',
  'ASFM SR Type',
  'Pending Reason'
];

function defaultAccount() {
  return createGdmsAccountProfile('hmil');
}

function pageSize(account) {
  return account.repairOrderPageSize || '1000';
}

function cloneReport(options, account) {
  return {
    id: options.id,
    name: options.name,
    sheetName: account.sheetName(options.sheetName),
    run: createHyundaiKiaCloneReport({
      ...options,
      sheetName: account.sheetName(options.sheetName),
      account,
      pageSize: pageSize(account),
      postSearchDelayMs: account.repairOrderPostSearchDelayMs
    })
  };
}

const DEFAULT_HMIL_REPORT_IDS = new Set([
  'hyundai-repair-order-list',
  'hyundai-ro-billing-report',
  'hyundai-call-center-complaints',
  'hyundai-demo-car-list',
  'hyundai-service-appointment',
  'hyundai-trust-package-bodyshop-sot',
  'hyundai-trust-package-sot-super',
  'hyundai-trust-package-package-list',
  'hyundai-psf-yearly',
  'hyundai-ew-report',
  'hyundai-adv-wise-lubricants-vas',
  'hyundai-operation-wise-analysis-report'
]);

function trustPackageReport({ id, name, sectionTitle }, account) {
  return cloneReport({
    id,
    name,
    sheetName: 'trust_package',
    open: page => openHmilTrustPackageSection(page, sectionTitle),
    dateFromSelector: '#sFromRegDate',
    dateToSelector: '#sToRegDate',
    saveEmptyDataset: true,
    metadata: {
      trust_package_section: sectionTitle
    }
  }, account);
}

function operationWiseReport(account) {
  if (account.id === 'am-platinum') {
    return {
      id: 'hyundai-operation-wise-analysis-report',
      name: 'Hyundai Operation Wise Analysis Report',
      sheetName: account.sheetName('Hyundai Operation Wise Analysis Report'),
      run: (page, options = {}) => runAmPlatinumOperationWiseForDealer(page, {
        ...options,
        account
      })
    };
  }

  return cloneReport({
    id: 'hyundai-operation-wise-analysis-report',
    name: 'Hyundai Operation Wise Analysis Report',
    sheetName: 'Hyundai Operation Wise Analysis Report',
    open: openAdvWiseLubricantsVasReport,
    dateFromSelector: '#startDate',
    dateToSelector: '#endDate',
    loopDropdown: {
      inputId: 'reportType',
      metadataHeader: 'report_type',
      excludeValues: []
    },
    preDateDropdowns: [
      { inputId: 'dateType', value: 'Billing Date', timeout: 10000 }
    ],
    metadata: {
      report_month: ({ range }) => {
        const startDate = new Date(`${range.startIso}T00:00:00`);
        return [
          startDate.getFullYear(),
          String(startDate.getMonth() + 1).padStart(2, '0'),
          '01'
        ].join('-');
      },
      report_period_start: ({ range }) => range.startIso,
      report_period_end: ({ range }) => range.endIso,
      report_type: ({ loopValue }) => loopValue
    }
  }, account);
}

export function createHmilReportDefinitions(account = defaultAccount()) {
  return [
    {
      id: 'hyundai-repair-order-list',
      name: 'Hyundai Repair Order List',
      sheetName: account.repairOrderSheetName,
      run: (page, options = {}) => downloadHyundaiRepairOrderListReport(page, { ...options, account })
    },
    cloneReport({
    id: 'hyundai-ro-billing-report',
    name: 'Hyundai RO Billing Report',
    sheetName: 'Hyundai RO Billing Report',
    open: openRoBillingReport,
    dateFromSelector: '#sBillDateFromDate',
    dateToSelector: '#sBillDateToDate'
  }, account),
    cloneReport({
    id: 'hyundai-call-center-complaints',
    name: 'Hyundai Call Center Complaints',
    sheetName: 'Hyundai Call Center Complaints',
    open: openHmilCallCenterComplaintServiceList,
    dateFromSelector: '#sCompStartDate',
    dateToSelector: '#sCompEndDate',
    parseOptions: {
      forcedHeaders: COMPLAINT_EXPORT_HEADERS
    }
  }, account),
    cloneReport({
    id: 'hyundai-customer-complaint-list',
    name: 'Hyundai Customer Complaint List',
    sheetName: 'Hyundai Customer Complaint List',
    open: openHmilCustomerComplaintList,
    dateFromSelector: '#sCompStartDate',
    dateToSelector: '#sCompEndDate',
    loopDropdown: {
      inputId: 'sCompSource',
      metadataHeader: 'complaint_source_filter',
      excludeValues: [' ', 'Select', 'All', 'Post Sales Feedback'],
      timeout: 30000
    }
  }, account),
    cloneReport({
    id: 'hyundai-open-ro-yearly',
    name: 'Hyundai Open RO Yearly',
    sheetName: 'Hyundai Open RO Yearly',
    open: openHmilRepairOrderListReport,
    dateFromSelector: '#sRoStrtDate',
    dateToSelector: '#sRoFnshDate',
    preSearchDropdowns: [
      { inputId: 'sRoStat', value: 'Open', timeout: 10000 }
    ]
  }, account),
    cloneReport({
    id: 'hyundai-demo-job-cards',
    name: 'Hyundai Demo Job Cards',
    sheetName: 'Hyundai Demo Job Cards',
    open: openHmilRepairOrderListReport,
    dateFromSelector: '#sRoStrtDate',
    dateToSelector: '#sRoFnshDate',
    preSearchDropdowns: [
      { inputId: 'sWorkType', value: config.demoJobCardsWorkType, timeout: 10000 }
    ]
  }, account),
    cloneReport({
    id: 'hyundai-demo-car-list',
    name: 'Hyundai Demo Car List',
    sheetName: 'Hyundai Demo Car List',
    open: openHmilPurchaseReport,
    dateFromSelector: '#sQueryFromDate',
    dateToSelector: '#sQueryToDate'
  }, account),
    cloneReport({
    id: 'hyundai-service-appointment',
    name: 'Hyundai Service Appointment',
    sheetName: 'Hyundai Service Appointment',
    open: openHmilServiceBookingListReport,
    dateFromSelector: '#sBkngFromDate',
    dateToSelector: '#sBkngToDate',
    rangeType: 'current-month-full'
  }, account),
    trustPackageReport({
    id: 'hyundai-trust-package-bodyshop-sot',
    name: 'Hyundai Trust Package - Bodyshop SOT Register',
    sectionTitle: 'Bodyshop - Shield of Trust (Non-insurance repair program) Register List'
  }, account),
    trustPackageReport({
    id: 'hyundai-trust-package-sot-super',
    name: 'Hyundai Trust Package - SOT Super Register',
    sectionTitle: 'SOT Super Register List'
  }, account),
    trustPackageReport({
    id: 'hyundai-trust-package-package-list',
    name: 'Hyundai Trust Package - Hyundai Shield of Trust Package List',
    sectionTitle: 'Hyundai Shield of Trust Package List'
  }, account),
    cloneReport({
    id: 'hyundai-psf-yearly',
    name: 'Hyundai PSF Yearly',
    sheetName: 'Hyundai PSF Yearly',
    open: openPsfYearlyReport,
    dateFromSelector: '#sRODateFromDate',
    dateToSelector: '#sRODateToDate'
  }, account),
    cloneReport({
    id: 'hyundai-ew-report',
    name: 'Hyundai EW Report',
    sheetName: 'Hyundai EW Report',
    open: openHmilExtendedWarrantyList,
    dateFromSelector: '#sRegDateFromDate',
    dateToSelector: '#sRegDateToDate',
    metadata: {
      report_type: 'EW',
      report_month: ({ range }) => range.startIso,
      report_period_start: ({ range }) => range.startIso,
      report_period_end: ({ range }) => range.endIso
    }
  }, account),
    cloneReport({
    id: 'hyundai-mcp-report',
    name: 'Hyundai MCP Report',
    sheetName: 'Hyundai MCP Report',
    open: openMcpReport,
    dateFromSelector: '#sFromRegDate',
    dateToSelector: '#sToRegDate'
  }, account),
    cloneReport({
    id: 'hyundai-adv-wise-lubricants-vas',
    name: 'Hyundai Adv. wise lubricants & VAS',
    sheetName: 'Hyundai Adv. wise lubricants & VAS',
    open: openAdvWiseLubricantsVasReport,
    dateFromSelector: '#startDate',
    dateToSelector: '#endDate',
    preDateDropdowns: [
      { inputId: 'dateType', value: 'Billing Date', timeout: 10000 }
    ]
  }, account),
    operationWiseReport(account)
  ];
}

export const hmilReportDefinitions = createHmilReportDefinitions();

export function getSelectedHmilReports(mode = 'all', account = defaultAccount()) {
  const reportDefinitions = createHmilReportDefinitions(account);
  const requested = mode && mode !== 'hyundai-regular' && mode !== account.defaultMode
    ? mode
    : account.reportsToRun;

  if (!requested || requested === 'all') {
    return reportDefinitions.filter(report => DEFAULT_HMIL_REPORT_IDS.has(report.id));
  }

  const ids = requested
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const selected = reportDefinitions.filter(report => ids.includes(report.id) || ids.includes(report.name));

  if (!selected.length) {
    throw new Error(`No ${account.logPrefix} reports matched: ${requested}`);
  }

  return selected;
}
