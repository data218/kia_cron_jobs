import fs from 'node:fs/promises';
import path from 'node:path';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { openRoBillingReport } from '../src/navigation/kia-menu.js';
import { openHmilRepairOrderListReport, openHmilOperationWiseAnalysisReport } from '../src/navigation/hmil-menu.js';
import { clickSearch, fillDate, selectKendoDropdownByInputId } from '../src/reports/report-actions.js';
import { waitForKendoGridIdle } from '../src/reports/grid.js';
import { findContextWithVisibleSelector } from '../src/playwright/frame-resolver.js';
import { config } from '../src/config.js';

const account = createGdmsAccountProfile('hmil'); // uses primary account
account.headless = false; // Show browser so user can see it and type OTP

const logFile = path.resolve(config.rootDir, './scratch/captured_requests_all.json');
const requests = [];

console.log('1. Logging in to HMIL DMS using standard browser automation...');
const session = await loginToHmilDms(account);
const page = session.page;

console.log('2. Setting up request/response interception...');
page.on('request', async request => {
  const method = request.method();
  const url = request.url();
  if (url.includes('ndms.hmil.net') && (method === 'POST' || url.includes('ServiceController') || url.endsWith('.json'))) {
    const postData = request.postData() || '';
    requests.push({
      type: 'request',
      timestamp: new Date().toISOString(),
      method,
      url,
      headers: request.headers(),
      postData
    });
  }
});

page.on('response', async response => {
  const url = response.url();
  const request = response.request();
  if (url.includes('ndms.hmil.net') && (request.method() === 'POST' || url.includes('ServiceController') || url.endsWith('.json'))) {
    let body = '';
    try {
      body = await response.text();
    } catch (e) {
      body = '[Binary/Unreadable]';
    }
    requests.push({
      type: 'response',
      timestamp: new Date().toISOString(),
      url,
      status: response.status(),
      headers: response.headers(),
      body
    });
  }
});

// Report 1: RO Billing Report
try {
  console.log('3. Navigating to RO Billing Report...');
  await openRoBillingReport(page);
  const context = await findContextWithVisibleSelector(page, '#sBillDateFromDate', { timeout: 30000 });
  console.log('Filling date range for RO Billing...');
  await fillDate(context, '#sBillDateFromDate', '01/06/2026');
  await fillDate(context, '#sBillDateToDate', '05/06/2026');
  console.log('Searching RO Billing...');
  await clickSearch(context);
  await waitForKendoGridIdle(context, { timeout: 30000 });
  await page.waitForTimeout(2000);
} catch (err) {
  console.error('Error in RO Billing capture:', err.message);
}

// Report 2: Repair Order List
try {
  console.log('4. Navigating to Repair Order List...');
  await openHmilRepairOrderListReport(page);
  const context = await findContextWithVisibleSelector(page, '#sRoStrtDate', { timeout: 30000 });
  console.log('Filling date range for Repair Order List...');
  await fillDate(context, '#sRoFnshDate', '05/06/2026');
  await fillDate(context, '#sRoStrtDate', '01/06/2026');
  console.log('Searching Repair Order List...');
  await clickSearch(context);
  await waitForKendoGridIdle(context, { timeout: 30000 });
  await page.waitForTimeout(2000);
} catch (err) {
  console.error('Error in Repair Order List capture:', err.message);
}

// Report 3: Operation Wise Analysis Report
try {
  console.log('5. Navigating to Operation Wise Analysis Report...');
  await openHmilOperationWiseAnalysisReport(page);
  const context = await findContextWithVisibleSelector(page, '#startDate', { timeout: 30000 });
  console.log('Filling date range for Operation Wise...');
  await selectKendoDropdownByInputId(context, 'dateType', 'Billing Date', { timeout: 10000 });
  await selectKendoDropdownByInputId(context, 'reportType', 'Operation', { timeout: 10000 });
  await fillDate(context, '#endDate', '05/06/2026');
  await fillDate(context, '#startDate', '01/06/2026');
  console.log('Searching Operation Wise...');
  await clickSearch(context);
  await waitForKendoGridIdle(context, { timeout: 30000 });
  await page.waitForTimeout(2000);
} catch (err) {
  console.error('Error in Operation Wise capture:', err.message);
}

console.log('6. Closing session and saving captured logs...');
await session.close().catch(() => {});

await fs.writeFile(logFile, JSON.stringify(requests, null, 2));
console.log(`✅ Saved ${requests.length} captured network operations to: ${logFile}`);
