import { config } from '../config.js';
import { openMcpReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { getCurrentMonthToDateRange } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { exportPagedGridToSupabase } from './paged-export.js';
import {
  clickSearch,
  fillDate
} from './report-actions.js';

async function resolveMcpReportContext(page) {
  const context = await findContextWithVisibleSelector(page, '#sFromRegDate', {
    timeout: 90000,
    label: 'MCP Report Registration Date From'
  });

  await context.locator('#sToRegDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#sDlrmRgnOfceNo').first().waitFor({ state: 'attached', timeout: 30000 }).catch(() => {});
  logger.info('My Convenience List page loaded');
  return context;
}

async function fillMcpDateRange(page, range) {
  logger.info('Applying MCP Report date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(page, '#sToRegDate', range.endPortal);
  await sleep(500);
  await fillDate(page, '#sFromRegDate', range.startPortal);
}

export async function downloadMcpReport(page) {
  logger.info('MCP Report started');
  await openMcpReport(page);
  const reportContext = await resolveMcpReportContext(page);

  const range = getCurrentMonthToDateRange();
  await fillMcpDateRange(reportContext, range);

  logger.info('Searching MCP Report');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Waiting briefly after MCP Report search before changing page size', {
    delayMs: config.mcpReportPostSearchDelayMs
  });
  await sleep(config.mcpReportPostSearchDelayMs);

  await selectKendoPagerSize(reportContext, config.mcpReportPageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Exporting MCP Report pages');
  const dbResult = await exportPagedGridToSupabase(reportContext, {
    reportId: 'mcp-report',
    sheetName: config.mcpReportSheetName,
    filenameBase: `mcp_report_${range.startIso}_to_${range.endIso}`,
    pageSize: config.mcpReportPageSize
  });

  logger.info('MCP Report finished', {
    sheetName: config.mcpReportSheetName,
    dbAction: dbResult.action,
    rowCount: dbResult.rowCount,
    headerCount: dbResult.headerCount,
    pageCount: dbResult.pageCount,
    addedRowCount: dbResult.addedRowCount,
    duplicateRowCount: dbResult.duplicateRowCount
  });

  return {
    name: 'MCP Report',
    sheetName: config.mcpReportSheetName,
    dbResult,
    dateRange: range
  };
}
