import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { openAdvWiseLubricantsVasReport } from '../navigation/kia-menu.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { saveReportSheetToRelationalTable } from '../supabase/relational-store.js';
import {
  addDays,
  formatDateForPortal,
  getCurrentMonthToDateRange,
  getReportDateOverrideRange,
  parseIsoLocalDate,
  toIsoDate
} from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from './grid.js';
import {
  cleanupReportExportDir,
  exportAllGridPagesToFiles,
  mergeExcelFiles
} from './paged-export.js';
import {
  clickSearch,
  fillDate,
  selectKendoDropdownByInputId
} from './report-actions.js';

const REPORT_TYPE = 'Operation';
const DATE_TYPE = 'Billing Date';

function sanitizeName(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function buildRunDir() {
  const now = new Date();
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('-');

  return path.join(
    config.reportChunksDir,
    'operation-wise-analysis-advisor-report',
    `${toIsoDate(now)}_${time}`
  );
}

function buildChunk(startDate, endDate) {
  const reportMonth = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  return {
    startDate,
    endDate,
    reportMonth,
    reportMonthIso: toIsoDate(reportMonth),
    startPortal: formatDateForPortal(startDate),
    endPortal: formatDateForPortal(endDate),
    startIso: toIsoDate(startDate),
    endIso: toIsoDate(endDate)
  };
}

function getMonthlyThirtyDayChunks(startDate, endDate) {
  const chunks = [];
  const firstDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const finalDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  let monthStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1);

  while (monthStart <= finalDate) {
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    const cappedStart = monthStart < firstDate ? firstDate : monthStart;
    const cappedEnd = monthEnd > finalDate ? finalDate : monthEnd;
    let chunkStart = cappedStart;

    while (chunkStart <= cappedEnd) {
      const thirtyDayEnd = addDays(chunkStart, 29);
      const chunkEnd = thirtyDayEnd > cappedEnd ? cappedEnd : thirtyDayEnd;
      chunks.push(buildChunk(chunkStart, chunkEnd));
      chunkStart = addDays(chunkEnd, 1);
    }

    monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  }

  return chunks;
}

async function resolveReportContext(page) {
  const context = await findContextWithVisibleSelector(page, '#startDate', {
    timeout: 90000,
    label: 'Operation Wise Analysis Advisor Report Start Date'
  });

  await context.locator('#endDate').first().waitFor({ state: 'visible', timeout: 30000 });
  await context.locator('#reportType').first().waitFor({ state: 'attached', timeout: 30000 });
  await context.locator('#dateType').first().waitFor({ state: 'attached', timeout: 30000 });
  await context.locator('#advEmpNo').first().waitFor({ state: 'attached', timeout: 30000 });
  logger.info('Operation Wise Analysis Advisor Report page loaded');
  return context;
}

async function getKendoDropdownText(page, inputId) {
  const widget = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]`
  ).first();

  return widget.locator('.k-input').first().innerText({ timeout: 5000 })
    .then(text => text.trim())
    .catch(() => '');
}

async function ensureKendoDropdownValue(page, inputId, value) {
  const currentValue = await getKendoDropdownText(page, inputId);
  if (currentValue === value) {
    logger.info('Kendo dropdown already selected', { inputId, value });
    return;
  }

  await selectKendoDropdownByInputId(page, inputId, value);
  await waitForKendoGridIdle(page, { timeout: 120000 });
}

async function getKendoDropdownOptions(page, inputId) {
  const widget = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]`
  ).first();
  const dropdownWrap = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]//span[contains(@class,"k-dropdown-wrap")]`
  ).first();

  await dropdownWrap.waitFor({ state: 'visible', timeout: 30000 });
  const ownedListboxId = await widget.getAttribute('aria-owns').catch(() => null);
  const listboxId = ownedListboxId || `${inputId}_listbox`;
  await dropdownWrap.click();

  const listItems = page.locator(`#${listboxId} li, #${listboxId} [role="option"]`);

  await listItems.first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  const texts = await listItems.evaluateAll(elements => elements
    .map(element => element.textContent?.trim() ?? '')
    .filter(Boolean));

  await dropdownWrap.click().catch(() => {});

  const seen = new Set();
  const nonAdvisorValues = new Set([
    'ro date',
    'billing date',
    'operation',
    'part',
    'report type',
    'date type'
  ]);
  return texts.filter(text => {
    const normalized = text.trim();
    if (!normalized || /^select$/i.test(normalized) || /^all$/i.test(normalized)) return false;
    if (nonAdvisorValues.has(normalized.toLowerCase())) return false;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function getServiceAdvisors(page) {
  const advisors = await getKendoDropdownOptions(page, 'advEmpNo');
  if (advisors.length) {
    logger.info('Service Advisor options detected', {
      count: advisors.length,
      advisors
    });
    return advisors;
  }

  const currentAdvisor = await getKendoDropdownText(page, 'advEmpNo');
  if (currentAdvisor) {
    logger.warn('Service Advisor option list was empty; using current selected advisor', {
      currentAdvisor
    });
    return [currentAdvisor];
  }

  throw new Error('No Service Advisor options found for Operation Wise Analysis Advisor Report');
}

function shouldSkipAdvisor(advisor, startAtAdvisor) {
  if (!startAtAdvisor) return false;
  return advisor.trim().toLowerCase() !== startAtAdvisor.trim().toLowerCase();
}

function filterChunksForResume(advisor, chunks, startAtAdvisor, startAtDate) {
  if (!startAtAdvisor || !startAtDate) return chunks;
  if (advisor.trim().toLowerCase() !== startAtAdvisor.trim().toLowerCase()) {
    return chunks;
  }

  return chunks.filter(chunk => chunk.endIso >= startAtDate);
}

async function fillDateRange(page, range) {
  logger.info('Applying Operation Wise Analysis Advisor date range', {
    startDate: range.startPortal,
    endDate: range.endPortal
  });

  await fillDate(page, '#endDate', range.endPortal);
  await fillDate(page, '#startDate', range.startPortal);
}

function addMetadataToDataset(advisor, range, merged) {
  const metadataHeaders = [
    'report_type',
    'date_type',
    'service_advisor',
    'report_month',
    'report_period_start',
    'report_period_end'
  ];
  const headers = [
    ...metadataHeaders,
    ...merged.headers.filter(header => !metadataHeaders.includes(header))
  ];
  const rows = merged.rows.map(row => ({
    report_type: REPORT_TYPE,
    date_type: DATE_TYPE,
    service_advisor: advisor,
    report_month: range.reportMonthIso,
    report_period_start: range.startIso,
    report_period_end: range.endIso,
    ...row
  }));

  return { headers, rows };
}

async function exportAdvisorDataset(page, {
  advisor,
  range,
  outputDir
}) {
  logger.info('[Operation Wise Analysis Advisor Report] Selecting Service Advisor', {
    advisor
  });
  await ensureKendoDropdownValue(page, 'advEmpNo', advisor);
  await ensureKendoDropdownValue(page, 'reportType', REPORT_TYPE);
  await ensureKendoDropdownValue(page, 'dateType', DATE_TYPE);
  await fillDateRange(page, range);

  logger.info('[Operation Wise Analysis Advisor Report] Searching advisor data', {
    advisor,
    startDate: range.startIso,
    endDate: range.endIso
  });
  await clickSearch(page);
  await waitForKendoGridIdle(page, { timeout: 120000 });

  if (config.operationWiseAnalysisAdvisorPostSearchDelayMs > 0) {
    logger.info('[Operation Wise Analysis Advisor Report] Waiting after search before page-size selection', {
      advisor,
      delayMs: config.operationWiseAnalysisAdvisorPostSearchDelayMs
    });
    await sleep(config.operationWiseAnalysisAdvisorPostSearchDelayMs);
  }

  await selectKendoPagerSize(page, config.operationWiseAnalysisAdvisorPageSize);
  await waitForKendoGridIdle(page, { timeout: 120000 });

  const advisorSlug = sanitizeName(advisor) || 'advisor';
  const filenameBase = [
    'operation_wise_analysis_advisor',
    advisorSlug,
    range.startIso,
    'to',
    range.endIso
  ].join('_');
  const advisorDir = path.join(outputDir, advisorSlug);
  const pageFiles = await exportAllGridPagesToFiles(page, {
    outputDir: advisorDir,
    filenameBase,
    pageSize: config.operationWiseAnalysisAdvisorPageSize,
    maxPages: 1000
  });

  const merged = await mergeExcelFiles(pageFiles);
  const dataset = addMetadataToDataset(advisor, range, merged);
  const dbResult = await saveReportSheetToRelationalTable({
    sheetName: config.operationWiseAnalysisAdvisorSheetName,
    headers: dataset.headers,
    rows: dataset.rows
  });

  await cleanupReportExportDir(advisorDir);

  logger.info('[Operation Wise Analysis Advisor Report] Advisor data saved', {
    advisor,
    tableName: dbResult.tableName,
    pageCount: pageFiles.length,
    rowCount: dataset.rows.length,
    insertedRowCount: dbResult.insertedRowCount,
    duplicateRowCount: dbResult.duplicateRowCount
  });

  return {
    advisor,
    pageCount: pageFiles.length,
    rowCount: dataset.rows.length,
    dbResult
  };
}

export async function downloadOperationWiseAnalysisAdvisorReport(page) {
  logger.info('Operation Wise Analysis Advisor Report started');
  await openAdvWiseLubricantsVasReport(page);
  const reportContext = await resolveReportContext(page);
  const monthRange = getCurrentMonthToDateRange();
  const overrideRange = getReportDateOverrideRange();
  const startDate = overrideRange?.startDate ?? (config.historicalBackfillEnabled
    ? parseIsoLocalDate(config.historicalBackfillStartDate)
    : config.operationWiseAnalysisAdvisorBackfillEnabled
      ? parseIsoLocalDate(config.operationWiseAnalysisAdvisorBackfillStartDate)
      : monthRange.startDate);
  const endDate = overrideRange?.endDate ?? monthRange.endDate;
  const chunks = getMonthlyThirtyDayChunks(startDate, endDate);
  const outputDir = buildRunDir();
  await fs.mkdir(outputDir, { recursive: true });

  await ensureKendoDropdownValue(reportContext, 'reportType', REPORT_TYPE);
  await ensureKendoDropdownValue(reportContext, 'dateType', DATE_TYPE);
  const allAdvisors = await getServiceAdvisors(reportContext);
  const startAtAdvisor = config.operationWiseAnalysisAdvisorStartAtAdvisor?.trim();
  const startAtDate = config.operationWiseAnalysisAdvisorStartAtDate?.trim();
  const startAdvisorIndex = startAtAdvisor
    ? allAdvisors.findIndex(advisor => advisor.trim().toLowerCase() === startAtAdvisor.toLowerCase())
    : -1;
  const advisors = startAdvisorIndex >= 0 ? allAdvisors.slice(startAdvisorIndex) : allAdvisors;

  logger.info('Operation Wise Analysis Advisor Report date chunks prepared', {
    mode: overrideRange ? 'date-override' : (config.historicalBackfillEnabled || config.operationWiseAnalysisAdvisorBackfillEnabled) ? 'historical-backfill' : 'current-month',
    startDate: toIsoDate(startDate),
    endDate: toIsoDate(endDate),
    chunkCount: chunks.length,
    advisorCount: advisors.length,
    resume: Boolean(startAtAdvisor || startAtDate),
    startAtAdvisor: startAtAdvisor || null,
    startAtDate: startAtDate || null
  });

  const results = [];
  try {
    for (const [index, advisor] of advisors.entries()) {
      if (shouldSkipAdvisor(advisor, startAtAdvisor) && startAdvisorIndex < 0) {
        logger.info('[Operation Wise Analysis Advisor Report] Advisor skipped by resume filter', {
          advisor,
          startAtAdvisor
        });
        continue;
      }

      const advisorChunks = filterChunksForResume(advisor, chunks, startAtAdvisor, startAtDate);
      if (!advisorChunks.length) {
        logger.info('[Operation Wise Analysis Advisor Report] Advisor skipped because resume date is after all chunks', {
          advisor,
          startAtDate
        });
        continue;
      }

      logger.info('[Operation Wise Analysis Advisor Report] Advisor run started', {
        advisor,
        advisorNumber: index + 1,
        advisorCount: advisors.length,
        chunkCount: advisorChunks.length
      });

      for (const [chunkIndex, range] of advisorChunks.entries()) {
        logger.info('[Operation Wise Analysis Advisor Report] Advisor chunk started', {
          advisor,
          advisorNumber: index + 1,
          advisorCount: advisors.length,
          chunkNumber: chunkIndex + 1,
          chunkCount: advisorChunks.length,
          reportMonth: range.reportMonthIso,
          startDate: range.startIso,
          endDate: range.endIso
        });

        const result = await exportAdvisorDataset(reportContext, {
          advisor,
          range,
          outputDir
        });
        results.push(result);

        if (chunkIndex < advisorChunks.length - 1) {
          if (config.operationWiseAnalysisAdvisorBetweenChunksDelayMs > 0) {
            await sleep(config.operationWiseAnalysisAdvisorBetweenChunksDelayMs);
          }
        }
      }

      if (index < advisors.length - 1) {
        if (config.operationWiseAnalysisAdvisorBetweenAdvisorsDelayMs > 0) {
          await sleep(config.operationWiseAnalysisAdvisorBetweenAdvisorsDelayMs);
        }
      }
    }
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }

  const rowCount = results.reduce((total, result) => total + Number(result.rowCount ?? 0), 0);
  const pageCount = results.reduce((total, result) => total + Number(result.pageCount ?? 0), 0);
  const insertedRowCount = results.reduce((total, result) =>
    total + Number(result.dbResult?.insertedRowCount ?? 0), 0);
  const duplicateRowCount = results.reduce((total, result) =>
    total + Number(result.dbResult?.duplicateRowCount ?? 0), 0);

  logger.info('Operation Wise Analysis Advisor Report finished', {
    sheetName: config.operationWiseAnalysisAdvisorSheetName,
    advisorCount: advisors.length,
    rowCount,
    pageCount,
    insertedRowCount,
    duplicateRowCount
  });

  return {
    name: 'Operation Wise Analysis Advisor Report',
    sheetName: config.operationWiseAnalysisAdvisorSheetName,
    dateRange: {
      startIso: toIsoDate(startDate),
      endIso: toIsoDate(endDate)
    },
    dbResult: {
      action: 'relational-advisor-batched-export',
      tableName: 'operation_wise_analysis_advisor_report',
      rowCount,
      pageCount,
      advisorCount: advisors.length,
      insertedRowCount,
      duplicateRowCount
    }
  };
}
