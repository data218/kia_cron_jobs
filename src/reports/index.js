import { downloadRoBillingReport } from './ro-billing.js';
import { downloadKiaCallCenterComplaintsReport } from './kia-call-center-complaints.js';
import { downloadOpenRoYearlyReport } from './open-ro-yearly.js';
import { downloadDemoJobCardsReport } from './demo-job-cards.js';
import { downloadDemoCarListReport } from './demo-car-list.js';
import { downloadServiceAppointmentReport } from './service-appointment.js';
import { downloadKiaBookingReport } from './kia-booking-report.js';
import { downloadKiaSalesReport } from './kia-sales-report.js';
import { downloadKiaEnquiryReport } from './kia-enquiry-report.js';
import { downloadKiaAccessoriesCounterSalesReport } from './kia-accessories-counter-sales-report.js';
import { downloadKiaPurchaseReport } from './kia-purchase-report.js';
import { downloadKiaReceiptReport } from './kia-receipt-report.js';
import { downloadKiaStockManagementReport } from './kia-stock-management.js';
import { downloadPsfYearlyReport } from './psf-yearly.js';
import { downloadEwReport } from './ew-report.js';
import { downloadMcpReport } from './mcp-report.js';
import { downloadRsaReport } from './rsa-report.js';
import { downloadAdvWiseLubricantsVasReport } from './adv-wise-lubricants-vas.js';
import { downloadOperationWiseAnalysisReport } from './operation-wise-analysis-report.js';
import { downloadOperationWiseAnalysisAdvisorReport } from './operation-wise-analysis-advisor-report.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { executeWithRetry } from '../utils/execute-with-retry.js';
import { sleep } from '../utils/sleep.js';
import { waitForConnectivity } from '../utils/network.js';

export const reportDefinitions = [
  {
    id: 'ro-billing',
    name: 'RO Billing Report',
    requiresKiaDms: true,
    run: downloadRoBillingReport
  },
  {
    id: 'kia-call-center-complaints',
    name: 'Kia Call Center Complaints',
    requiresKiaDms: true,
    run: downloadKiaCallCenterComplaintsReport
  },
  {
    id: 'open-ro-yearly',
    name: 'Open RO Yearly',
    requiresKiaDms: true,
    run: downloadOpenRoYearlyReport
  },
  {
    id: 'demo-job-cards',
    name: 'Demo Job Cards',
    requiresKiaDms: true,
    run: downloadDemoJobCardsReport
  },
  {
    id: 'demo-car-list',
    name: 'Demo Car List',
    requiresKiaDms: true,
    run: downloadDemoCarListReport
  },
  {
    id: 'service-appointment',
    name: 'Service Appointment',
    requiresKiaDms: true,
    run: downloadServiceAppointmentReport
  },
  {
    id: 'kia-booking-report',
    name: 'Booking Report',
    requiresKiaDms: true,
    noDealerSwitch: true,
    run: downloadKiaBookingReport
  },
  {
    id: 'kia-sales-report',
    name: 'Sales Report',
    requiresKiaDms: true,
    noDealerSwitch: true,
    run: downloadKiaSalesReport
  },
  {
    id: 'kia-enquiry-report',
    name: 'Enquiry Report',
    requiresKiaDms: true,
    noDealerSwitch: true,
    run: downloadKiaEnquiryReport
  },
  {
    id: 'kia-accessories-counter-sales-report',
    name: 'Accessories Counter Sales Report',
    requiresKiaDms: true,
    run: downloadKiaAccessoriesCounterSalesReport
  },
  {
    id: 'kia-purchase-report',
    name: 'Purchase Report',
    requiresKiaDms: true,
    noDealerSwitch: true,
    run: downloadKiaPurchaseReport
  },
  {
    id: 'kia-receipt-report',
    name: 'Receipt Report',
    requiresKiaDms: true,
    run: downloadKiaReceiptReport
  },
  {
    id: 'kia-stock-management',
    name: 'Kia Stock Management',
    requiresKiaDms: true,
    run: downloadKiaStockManagementReport
  },
  {
    id: 'psf-yearly',
    name: 'PSF Yearly',
    requiresKiaDms: true,
    run: downloadPsfYearlyReport
  },
  {
    id: 'ew-report',
    name: 'EW Report',
    requiresKiaDms: true,
    run: downloadEwReport
  },
  {
    id: 'mcp-report',
    name: 'MCP Report',
    requiresKiaDms: true,
    run: downloadMcpReport
  },
  {
    id: 'adv-wise-lubricants-vas',
    name: 'Adv. wise lubricants & VAS',
    requiresKiaDms: true,
    run: downloadAdvWiseLubricantsVasReport
  },
  {
    id: 'operation-wise-analysis-report',
    name: 'Operation Wise Analysis Report',
    requiresKiaDms: true,
    run: downloadOperationWiseAnalysisReport
  },
  {
    id: 'operation-wise-analysis-advisor-report',
    name: 'Operation Wise Analysis Advisor Report',
    requiresKiaDms: true,
    run: downloadOperationWiseAnalysisAdvisorReport
  },
  {
    id: 'rsa-report',
    name: 'RSA Report',
    requiresKiaDms: false,
    includeInAll: false,
    run: downloadRsaReport
  }
];

const defaultReportDefinitions = reportDefinitions.filter(report => report.includeInAll !== false);
const regularReportDefinitions = defaultReportDefinitions.filter(report =>
  ![
    'open-ro-yearly',
    'kia-call-center-complaints',
    'demo-job-cards',
    'demo-car-list',
    'service-appointment',
    'kia-booking-report',
    'kia-sales-report',
    'kia-enquiry-report',
    'kia-accessories-counter-sales-report',
    'kia-purchase-report',
    'kia-receipt-report',
    'kia-stock-management',
    'rsa-report',
    'ro-billing'
  ].includes(report.id)
);

const MODE_REPORT_IDS = new Map([
  ['open-ro-yearly', 'open-ro-yearly'],
  ['kia-call-center-complaints', 'kia-call-center-complaints'],
  ['demo-job-cards', 'demo-job-cards'],
  ['demo-car-list', 'demo-car-list'],
  ['service-appointment', 'service-appointment'],
  ['rsa-report', 'rsa-report'],
  ['ro-billing', 'ro-billing'],
  ['kia-booking-report', 'kia-booking-report'],
  ['kia-booking-report-historical', 'kia-booking-report'],
  ['kia-sales-report', 'kia-sales-report'],
  ['kia-sales-report-historical', 'kia-sales-report'],
  ['kia-enquiry-report', 'kia-enquiry-report'],
  ['kia-enquiry-report-historical', 'kia-enquiry-report'],
  ['kia-accessories-counter-sales-report', 'kia-accessories-counter-sales-report'],
  ['kia-accessories-counter-sales-report-historical', 'kia-accessories-counter-sales-report'],
  ['kia-purchase-report', 'kia-purchase-report'],
  ['kia-purchase-report-historical', 'kia-purchase-report'],
  ['kia-receipt-report', 'kia-receipt-report'],
  ['kia-receipt-report-historical', 'kia-receipt-report'],
  ['kia-stock-management', 'kia-stock-management']
]);

export function getSelectedReports({ mode = 'configured' } = {}) {
  if (config.testSingleReport) {
    const testReportName = config.testReportName.trim().toLowerCase();
    if (!testReportName) {
      throw new Error('TEST_SINGLE_REPORT=true requires TEST_REPORT_NAME to be set');
    }

    const selected = reportDefinitions.filter(report =>
      report.id === testReportName || report.name.toLowerCase() === testReportName
    );

    if (!selected.length) {
      throw new Error(`Unknown TEST_REPORT_NAME value: ${config.testReportName}`);
    }

    return selected;
  }

  const modeReportId = MODE_REPORT_IDS.get(mode);
  if (modeReportId) {
    return reportDefinitions.filter(report => report.id === modeReportId);
  }

  const requested = config.reportsToRun
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  if (!requested.length || requested.includes('all')) {
    return mode === 'regular' ? regularReportDefinitions : defaultReportDefinitions;
  }

  const selected = reportDefinitions.filter(report => requested.includes(report.id));
  const selectedIds = new Set(selected.map(report => report.id));
  const unknown = requested.filter(id => !selectedIds.has(id));

  if (unknown.length) {
    throw new Error(`Unknown REPORTS_TO_RUN value(s): ${unknown.join(', ')}`);
  }

  return selected;
}

export function selectedReportsRequireKiaDms() {
  return getSelectedReports().some(report => report.requiresKiaDms);
}

export function selectedReportsRequireKiaDmsForMode(mode) {
  if (config.dryRunReports) {
    return false;
  }

  return getSelectedReports({ mode }).some(report => report.requiresKiaDms);
}

async function runDryReport(report, mode) {
  logger.info('Dry-run report started', {
    report: report.name,
    reportId: report.id,
    mode,
    delayMs: config.dryRunReportDelayMs
  });
  if (config.dryRunReportDelayMs > 0) {
    await sleep(config.dryRunReportDelayMs);
  }
  logger.info('Dry-run report completed', {
    report: report.name,
    reportId: report.id,
    mode
  });

  return {
    name: report.name,
    sheetName: report.name,
    dryRun: true,
    dbResult: {
      action: 'dry-run',
      rowCount: 0,
      headerCount: 0
    }
  };
}

export async function runConfiguredReports(page, { mode = 'configured', dealerCode = 'active', reports } = {}) {
  const results = [];
  const selectedReports = reports ?? getSelectedReports({ mode });

  logger.info('Configured reports selected', {
    reportsToRun: config.reportsToRun,
    mode,
    dealerCode,
    count: selectedReports.length,
    reports: selectedReports.map(report => report.id)
  });

  for (const report of selectedReports) {
    logger.info('Starting report', { report: report.name, dealerCode });
    const startedAt = Date.now();
    try {
      await waitForConnectivity({ label: `${report.name} preflight` });
      const result = await executeWithRetry({
        name: report.name,
        page,
        fn: () => config.dryRunReports
          ? runDryReport(report, mode)
          : report.run(page, { dealerCode, mode })
      });
      results.push({
        ...result,
        dealerCode
      });
      logger.info('Completed report', {
        report: report.name,
        dealerCode,
        sheetName: result.sheetName,
        dbAction: result.dbResult?.action,
        rowCount: result.dbResult?.rowCount,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      logger.error('Report failed after all retries; continuing with remaining reports', {
        report: report.name,
        dealerCode,
        durationMs: Date.now() - startedAt,
        err: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      });
      results.push({
        name: report.name,
        sheetName: null,
        dealerCode,
        failed: true,
        error: {
          name: error.name,
          message: error.message
        }
      });
    }
  }

  return results;
}
