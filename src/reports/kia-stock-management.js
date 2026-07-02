import path from 'node:path';
import { config } from '../config.js';
import { openDealerVehicleStockMgtReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import {
  cleanupReportExportDir,
  exportAllGridPagesToFiles,
  mergeExcelFiles
} from './paged-export.js';
import { clickSearch, selectKendoDropdownByInputId } from './report-actions.js';

const REPORT_NAME = 'Kia Stock Management';
const REPORT_ID = 'kia-stock-management';

async function resolveStockMgtContext(page) {
  // Use #btnSearch since it is visible, whereas the Kendo dropdown #sPhyTrn
  // is hidden with style="display: none;".
  const context = await findContextWithVisibleSelector(page, '#btnSearch', {
    timeout: 90000,
    label: `${REPORT_NAME} search button`
  });
  logger.info(`${REPORT_NAME} page loaded`);
  return context;
}

export async function downloadKiaStockManagementReport(page) {
  logger.info(`${REPORT_NAME} report started`);

  await openDealerVehicleStockMgtReport(page);
  const reportContext = await resolveStockMgtContext(page);

  // The dropdown defaults to "In Transit". We must change it to the
  // blank/all option so the grid returns every vehicle in stock.
  logger.info(`${REPORT_NAME}: setting Physical Transit filter to (All)`);
  await selectKendoDropdownByInputId(reportContext, 'sPhyTrn', '');

  logger.info(`${REPORT_NAME}: clicking Search`);
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  if (config.kiaStockManagementPostSearchDelayMs > 0) {
    logger.info(`${REPORT_NAME}: waiting after search`, {
      delayMs: config.kiaStockManagementPostSearchDelayMs
    });
    await sleep(config.kiaStockManagementPostSearchDelayMs);
  }

  await selectKendoPagerSize(reportContext, config.kiaStockManagementPageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  const runDate = toIsoDate(new Date());
  const chunkDir = path.join(config.reportChunksDir, REPORT_ID, runDate);

  const exportFiles = await exportAllGridPagesToFiles(reportContext, {
    outputDir: chunkDir,
    filenameBase: 'kia_stock_management',
    pageSize: config.kiaStockManagementPageSize
  });

  if (!exportFiles.length) {
    logger.info(`${REPORT_NAME} report has no data; skipping export`);
    return {
      name: REPORT_NAME,
      sheetName: config.kiaStockManagementSheetName,
      dbResult: { action: 'no_rows', rowCount: 0, headerCount: 0 }
    };
  }

  const merged = await mergeExcelFiles(exportFiles);

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.kiaStockManagementSheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(chunkDir);

  logger.info(`${REPORT_NAME} report finished`, {
    sheetName: config.kiaStockManagementSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    fileCount: exportFiles.length
  });

  return {
    name: REPORT_NAME,
    sheetName: config.kiaStockManagementSheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length
    },
    fileCount: exportFiles.length
  };
}
