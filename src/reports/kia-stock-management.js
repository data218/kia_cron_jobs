import path from 'node:path';
import { config } from '../config.js';
import { openDealerVehicleStockMgtReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { withPostgresClient } from '../supabase/postgres.js';
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

async function clearStockTableForDealer(dealerCode) {
  return withPostgresClient(async client => {
    logger.info(`Deleting existing non-invoice stock records for dealer ${dealerCode}`);
    const res = await client.query(
      `DELETE FROM public.kia_stock_management 
       WHERE upper(trim(order_dealer)) = upper(trim($1))
         AND upper(trim(coalesce(stock_status, ''))) != 'INVOICE'`,
      [dealerCode]
    );
    logger.info(`Deleted ${res.rowCount} existing non-invoice stock records for dealer ${dealerCode}`);
  });
}

// kia_stock_report intentionally has NO delete function.
// Old vehicle records are preserved forever; only new VINs are inserted (DO NOTHING on conflict).

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

function getRowValue(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return String(row[k]).trim();
    }
  }
  const normalizedKeys = keys.map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const prop of Object.keys(row)) {
    const normProp = prop.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedKeys.includes(normProp)) {
      if (row[prop] !== undefined && row[prop] !== null && String(row[prop]).trim() !== '') {
        return String(row[prop]).trim();
      }
    }
  }
  return '';
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

  // Save all rows including Invoice to kia_stock_management
  const stockManagementRows = merged.rows;

  if (merged.rows.length > 0) {
    const uniqueDealers = [...new Set(merged.rows.map(row => getRowValue(row, 'order_dealer', 'Order Dealer', 'Order_Dealer', 'dealer_code')).filter(Boolean))];
    logger.info('Deduplicated dealers from exported stock dataset', {
      uniqueDealers,
      report: REPORT_NAME
    });
    for (const dealer of uniqueDealers) {
      // Delete non-invoice records + re-insert fresh data for kia_stock_management.
      // Retain existing Invoice stock permanently.
      await clearStockTableForDealer(dealer);
    }
  }

  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.kiaStockManagementSheetName,
    headers: merged.headers,
    rows: stockManagementRows
  });

  const dbReportResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: 'kia_stock_report',
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
