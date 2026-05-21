import { downloadRoBillingReport } from './ro-billing.js';
import { downloadKiaCallCenterComplaintsReport } from './kia-call-center-complaints.js';
import { downloadOpenRoYearlyReport } from './open-ro-yearly.js';
import { downloadPsfYearlyReport } from './psf-yearly.js';
import { downloadEwReport } from './ew-report.js';
import { downloadMcpReport } from './mcp-report.js';
import { downloadRsaReport } from './rsa-report.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const reportDefinitions = [
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
    id: 'rsa-report',
    name: 'RSA Report',
    requiresKiaDms: false,
    run: downloadRsaReport
  }
];

export function getSelectedReports() {
  const requested = config.reportsToRun
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  if (!requested.length || requested.includes('all')) {
    return reportDefinitions;
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

export async function runConfiguredReports(page) {
  const results = [];
  const selectedReports = getSelectedReports();

  logger.info('Configured reports selected', {
    reportsToRun: config.reportsToRun,
    count: selectedReports.length,
    reports: selectedReports.map(report => report.id)
  });

  for (const report of selectedReports) {
    logger.info('Starting report', { report: report.name });
    const result = await report.run(page);
    results.push(result);
    logger.info('Completed report', {
      report: report.name,
      sheetName: result.sheetName,
      dbAction: result.dbResult?.action,
      rowCount: result.dbResult?.rowCount
    });
  }

  return results;
}
