import { config } from '../config.js';
import { openAdvWiseLubricantsVasReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { getCurrentMonthToDateRange } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import { exportPagedGridToSupabase } from './paged-export.js';
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByInputId
} from './report-actions.js';

async function resolveAdvWiseLubricantsVasContext(page) {
  const context = await findContextWithVisibleSelector(page, '#startDate', {
    timeout: 90000,
    label: 'Operation Wise Analysis Report Start Date'
  });

  await context.locator('#endDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#dateType').first().waitFor({ state: 'attached', timeout: 30000 });
  logger.info('Operation Wise Analysis Report page loaded');
  return context;
}

async function ensureBillingDateType(page) {
  logger.info('Ensuring Operation Wise Analysis Report date type', {
    dateType: 'Billing Date'
  });

  try {
    await selectKendoDropdownByInputId(page, 'dateType', 'Billing Date');
    return;
  } catch (error) {
    logger.warn('Kendo dateType dropdown selection failed; applying direct fallback', error);
  }

  const input = page.locator('#dateType').first();
  await input.waitFor({ state: 'attached', timeout: 30000 });

  if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
    await input.fill('');
    await input.fill('Billing Date');
    await input.press('Tab').catch(() => {});
    return;
  }

  await input.evaluate(element => {
    element.value = 'Billing Date';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function fillAdvWiseLubricantsVasDateRange(page, range) {
  logger.info('Applying Adv. wise lubricants & VAS date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(page, '#endDate', range.endPortal);
  await sleep(500);
  await fillDate(page, '#startDate', range.startPortal);
}

export async function downloadAdvWiseLubricantsVasReport(page) {
  logger.info('Adv. wise lubricants & VAS started');
  await openAdvWiseLubricantsVasReport(page);
  const reportContext = await resolveAdvWiseLubricantsVasContext(page);

  const range = getCurrentMonthToDateRange();
  await ensureBillingDateType(reportContext);
  await fillAdvWiseLubricantsVasDateRange(reportContext, range);

  logger.info('Searching Adv. wise lubricants & VAS');
  await clickSearch(reportContext);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Waiting briefly after Adv. wise lubricants & VAS search before changing page size', {
    delayMs: config.advWiseLubricantsVasPostSearchDelayMs
  });
  await sleep(config.advWiseLubricantsVasPostSearchDelayMs);

  await selectKendoPagerSize(reportContext, config.advWiseLubricantsVasPageSize);
  await waitForKendoGridIdle(reportContext, { timeout: 120000 });

  logger.info('Exporting Adv. wise lubricants & VAS pages');
  const dbResult = await exportPagedGridToSupabase(reportContext, {
    reportId: 'adv-wise-lubricants-vas',
    sheetName: config.advWiseLubricantsVasSheetName,
    filenameBase: `adv_wise_lubricants_vas_${range.startIso}_to_${range.endIso}`,
    pageSize: config.advWiseLubricantsVasPageSize
  });

  logger.info('Adv. wise lubricants & VAS finished', {
    sheetName: config.advWiseLubricantsVasSheetName,
    dbAction: dbResult.action,
    rowCount: dbResult.rowCount,
    headerCount: dbResult.headerCount,
    pageCount: dbResult.pageCount,
    addedRowCount: dbResult.addedRowCount,
    duplicateRowCount: dbResult.duplicateRowCount
  });

  return {
    name: 'Adv. wise lubricants & VAS',
    sheetName: config.advWiseLubricantsVasSheetName,
    dbResult,
    dateRange: range
  };
}
