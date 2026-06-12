import path from 'node:path';
import { config } from '../config.js';
import { openMcpReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { formatDateForPortal, getCurrentMonthToDateRange, getReportDateOverrideRange, getThirtyDayChunks, parseIsoLocalDate, toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { cleanupReportExportDir, exportAllGridPagesToFiles, mergeExcelFiles } from './paged-export.js';
import {
  clickSearch,
  fillDate
} from './report-actions.js';
import { addDealerCodeToDataset } from './report-metadata.js';

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
  await fillDate(page, '#sFromRegDate', range.startPortal);
}

export async function downloadMcpReport(page, { dealerCode = 'active' } = {}) {
  logger.info('MCP Report started', { dealerCode });
  await openMcpReport(page);
  const reportContext = await resolveMcpReportContext(page);

  const overrideRange = getReportDateOverrideRange();
  const range = overrideRange ?? (config.historicalBackfillEnabled
    ? {
        startDate: parseIsoLocalDate(config.historicalBackfillStartDate),
        endDate: new Date()
      }
    : getCurrentMonthToDateRange());
  if (config.historicalBackfillEnabled && !overrideRange) {
    range.startPortal = formatDateForPortal(range.startDate);
    range.endPortal = formatDateForPortal(range.endDate);
    range.startIso = toIsoDate(range.startDate);
    range.endIso = toIsoDate(range.endDate);
  }

  const chunks = (config.historicalBackfillEnabled || overrideRange)
    ? getThirtyDayChunks(range.startDate, range.endDate)
    : [range];
  const exportDir = path.join(config.reportChunksDir, 'mcp-report', toIsoDate(new Date()));
  const exportFiles = [];

  logger.info('MCP Report date chunks prepared', {
    dealerCode,
    mode: config.historicalBackfillEnabled ? 'historical-backfill' : 'current-month',
    startDate: range.startIso,
    endDate: range.endIso,
    chunkCount: chunks.length,
    exportDir
  });

  for (const [index, chunk] of chunks.entries()) {
    await fillMcpDateRange(reportContext, chunk);

    logger.info('Searching MCP Report chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startPortal,
      endDate: chunk.endPortal
    });
    await clickSearch(reportContext);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    if (config.mcpReportPostSearchDelayMs > 0) {
      logger.info('Waiting briefly after MCP Report search before changing page size', {
        delayMs: config.mcpReportPostSearchDelayMs
      });
      await sleep(config.mcpReportPostSearchDelayMs);
    }

    await selectKendoPagerSize(reportContext, config.mcpReportPageSize);
    await waitForKendoGridIdle(reportContext, { timeout: 120000 });

    logger.info('Exporting MCP Report chunk pages');
    const chunkFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: exportDir,
      filenameBase: `mcp_report_${chunk.startIso}_to_${chunk.endIso}`,
      pageSize: config.mcpReportPageSize
    });
    exportFiles.push(...chunkFiles);
  }

  const merged = addDealerCodeToDataset(await mergeExcelFiles(exportFiles), dealerCode);
  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.mcpReportSheetName,
    headers: merged.headers,
    rows: merged.rows
  });
  await cleanupReportExportDir(exportDir);

  logger.info('MCP Report finished', {
    sheetName: config.mcpReportSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    pageCount: exportFiles.length,
    addedRowCount: dbResult.addedRowCount,
    duplicateRowCount: dbResult.duplicateRowCount
  });

  return {
    name: 'MCP Report',
    sheetName: config.mcpReportSheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length,
      pageCount: exportFiles.length
    },
    dateRange: range
  };
}
