import 'dotenv/config';
import path from 'node:path';
import { config } from '../src/config.js';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { logger } from '../src/utils/logger.js';
import { findContextWithVisibleSelector } from '../src/playwright/frame-resolver.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { openAdvWiseLubricantsVasReport } from '../src/navigation/kia-menu.js';
import { selectKendoPagerSize, waitForKendoGridIdle } from '../src/reports/grid.js';
import { exportAllGridPagesToFiles, mergeExcelFiles, cleanupReportExportDir } from '../src/reports/paged-export.js';
import { fillDate, selectKendoDropdownByInputId } from '../src/reports/report-actions.js';
import { formatDateForPortal, parseIsoLocalDate, toIsoDate } from '../src/utils/date-range.js';
import { saveReportSheetToSupabase } from '../src/supabase/report-store.js';
import { sleep } from '../src/utils/sleep.js';

const START_DATE_ISO = '2021-01-01';
const END_DATE_ISO = toIsoDate(new Date());
const PAGE_SIZE = '1000';

const REPORTS = [
  {
    id: 'am_platinum_adv_wise_lubricants_vas',
    name: 'Adv. wise lubricants & VAS',
    sheetName: 'AM Platinum Adv. wise lubricants & VAS',
    reportType: null, // No report type for this one
    requiresReload: false
  },
  {
    id: 'am_platinum_operation_wise_analysis_report',
    name: 'Operation Wise Analysis Report',
    sheetName: 'AM Platinum Operation Wise Analysis Report',
    reportType: 'Operation',
    requiresReload: true
  }
];

const DEALERS = ['N5211', 'N6250', 'N6828'];

async function resolveDateContext(page, label) {
  const context = await findContextWithVisibleSelector(page, '#startDate', {
    timeout: 90000,
    label
  });

  await context.locator('#endDate').first().waitFor({ state: 'visible', timeout: 30000 });
  logger.info(`${label} page loaded`);
  return context;
}

async function ensureBillingDateType(page) {
  logger.info('Ensuring date type is set to Billing Date');
  try {
    await selectKendoDropdownByInputId(page, 'dateType', 'Billing Date');
    await waitForKendoGridIdle(page, { timeout: 30000 });
  } catch (error) {
    logger.warn('dateType dropdown selection failed', error.message);
  }
}

async function ensureReportType(page, reportType) {
  if (!reportType) return;
  logger.info(`Ensuring report type is set to ${reportType}`);
  try {
    await selectKendoDropdownByInputId(page, 'reportType', reportType);
    await waitForKendoGridIdle(page, { timeout: 30000 });
  } catch (error) {
    logger.warn(`reportType dropdown selection failed for ${reportType}`, error.message);
  }
}

async function runReportForDealer(page, report, dealerCode) {
  logger.info(`\n${'='.repeat(80)}`);
  logger.info(`Running ${report.name} for dealer ${dealerCode}`);
  logger.info(`${'='.repeat(80)}`);

  try {
    // Open/reload report if needed
    if (report.requiresReload) {
      logger.info(`Opening ${report.name} page`);
      await openAdvWiseLubricantsVasReport(page);
      await sleep(2000); // Brief pause after navigation
    }
    
    // Wait for form to load
    const reportContext = await resolveDateContext(page, `${report.name} Start Date`);
    
    // Set date type
    await ensureBillingDateType(reportContext);
    
    // Set report type if needed
    if (report.reportType) {
      await ensureReportType(reportContext, report.reportType);
    }

    // Parse dates
    const startDate = parseIsoLocalDate(START_DATE_ISO);
    const endDate = parseIsoLocalDate(END_DATE_ISO);
    const startPortal = formatDateForPortal(startDate);
    const endPortal = formatDateForPortal(endDate);

    // Fill date range
    logger.info(`Filling date range: ${startPortal} to ${endPortal}`);
    await fillDate(reportContext, '#endDate', endPortal);
    await fillDate(reportContext, '#startDate', startPortal);
    
    // Set page size WITHOUT clicking search button
    logger.info(`Setting page size to ${PAGE_SIZE} (skipping search button)`);
    await selectKendoPagerSize(reportContext, PAGE_SIZE);
    
    // Wait for data to load (this is the key step - data loads automatically)
    logger.info(`Waiting for data to load from ${START_DATE_ISO} to ${END_DATE_ISO}...`);
    logger.info(`This may take 5-10 minutes depending on data size...`);
    await waitForKendoGridIdle(reportContext, { timeout: 600000 }); // 10 minute timeout
    
    // Export all pages
    const exportDir = path.join(
      config.reportChunksDir,
      'am-platinum',
      report.id,
      dealerCode,
      `${START_DATE_ISO}_to_${END_DATE_ISO}`
    );
    
    logger.info(`Exporting all pages to: ${exportDir}`);
    const pageFiles = await exportAllGridPagesToFiles(reportContext, {
      outputDir: exportDir,
      filenameBase: `${report.id.replace(/^am_platinum_/, '')}_${dealerCode}_${START_DATE_ISO.replaceAll('-', '_')}_to_${END_DATE_ISO.replaceAll('-', '_')}`,
      pageSize: PAGE_SIZE,
      downloadTimeoutMs: 60000,
      maxPages: 1000
    });
    
    logger.info(`Exported ${pageFiles.length} pages`);
    
    if (!pageFiles.length) {
      logger.warn(`No data exported for ${report.name} - ${dealerCode}`);
      await cleanupReportExportDir(exportDir);
      return {
        report: report.name,
        dealer: dealerCode,
        status: 'no_data',
        rowCount: 0,
        pageCount: 0
      };
    }
    
    // Merge exported files
    logger.info(`Merging ${pageFiles.length} page files...`);
    const merged = await mergeExcelFiles(pageFiles);
    
    logger.info(`Merged data: ${merged.rows.length} rows, ${merged.headers.length} columns`);
    
    // Add dealer code to rows
    const withDealer = {
      ...merged,
      rows: merged.rows.map(row => ({ ...row, source_dealer_code: dealerCode }))
    };
    
    // Save to database
    logger.info(`Saving ${withDealer.rows.length} rows to database...`);
    const dbResult = await saveReportSheetToSupabase({
      brand: 'am_platinum',
      sheetName: report.sheetName,
      headers: withDealer.headers,
      rows: withDealer.rows
    });
    
    logger.info(`Database save result:`, dbResult);
    
    // Cleanup
    await cleanupReportExportDir(exportDir);
    
    return {
      report: report.name,
      dealer: dealerCode,
      status: 'success',
      rowCount: withDealer.rows.length,
      pageCount: pageFiles.length,
      dbAction: dbResult.action
    };
    
  } catch (error) {
    logger.error(`Error running ${report.name} for ${dealerCode}:`, error);
    return {
      report: report.name,
      dealer: dealerCode,
      status: 'error',
      error: error.message
    };
  }
}

async function main() {
  const account = {
    ...createGdmsAccountProfile('am-platinum'),
    otpProvider: process.env.AM_PLATINUM_HISTORICAL_OTP_PROVIDER
      || config.amPlatinumHistoricalOtpProvider
      || 'manual',
    headless: false
  };
  let loginSession;
  const results = [];

  try {
    logger.info('\n' + '='.repeat(80));
    logger.info('AM PLATINUM MANUAL EXPORT - NO SEARCH BUTTON APPROACH');
    logger.info('='.repeat(80));
    logger.info(`Start Date: ${START_DATE_ISO}`);
    logger.info(`End Date: ${END_DATE_ISO}`);
    logger.info(`Page Size: ${PAGE_SIZE}`);
    logger.info(`Reports: ${REPORTS.map(r => r.name).join(', ')}`);
    logger.info(`Dealers: ${DEALERS.join(', ')}`);
    logger.info('\nApproach:');
    logger.info('1. Set start date to 2021-01-01');
    logger.info('2. Set page size to 1000');
    logger.info('3. Skip search button (data loads automatically)');
    logger.info('4. Export all pages');
    logger.info('5. Merge and upload to database');
    logger.info('='.repeat(80) + '\n');

    // Login
    logger.info('Logging in to AM Platinum system...');
    loginSession = await loginToHmilDms(account);
    const page = loginSession.page;
    logger.info('Login successful\n');
    
    // Open report page once
    logger.info('Opening report page...');
    await openAdvWiseLubricantsVasReport(page);
    await sleep(2000);
    
    // Run reports for each dealer
    let activeDealerCode = null;
    for (const dealer of DEALERS) {
      if (activeDealerCode !== dealer) {
        logger.info(`Switching active dealer to ${dealer}`);
        await changeActiveDealerForDms(page, dealer, {
          homeUrl: account.homeUrl,
          systemLabel: account.systemLabel
        });
        activeDealerCode = dealer;
        await openAdvWiseLubricantsVasReport(page);
        await sleep(2000);
      }

      for (const report of REPORTS) {
        const result = await runReportForDealer(page, report, dealer);
        results.push(result);
        
        // Brief pause between reports
        if (report !== REPORTS[REPORTS.length - 1]) {
          await sleep(2000);
        }
      }
    }
    
  } finally {
    if (loginSession) {
      await loginSession.close();
    }
  }
  
  // Print summary
  logger.info('\n' + '='.repeat(80));
  logger.info('SUMMARY');
  logger.info('='.repeat(80));
  
  for (const result of results) {
    const status = result.status === 'success' ? '✅' : '❌';
    const detail = result.status === 'success'
      ? `${result.rowCount} rows (${result.pageCount} pages)`
      : result.error ?? result.status;
    logger.info(`${status} ${result.report} - ${result.dealer}: ${detail}`);
  }
  
  const successCount = results.filter(r => r.status === 'success').length;
  const totalCount = results.length;
  
  logger.info(`\nTotal: ${successCount}/${totalCount} completed successfully`);
  logger.info('='.repeat(80) + '\n');
  
  process.exit(successCount === totalCount ? 0 : 1);
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
