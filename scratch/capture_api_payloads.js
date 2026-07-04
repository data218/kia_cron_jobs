process.env.OTP_PROVIDER = 'manual';

import fs from 'node:fs/promises';
import path from 'node:path';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { openRoBillingReport } from '../src/navigation/kia-menu.js';
import { clickSearch, fillDate } from '../src/reports/report-actions.js';
import { waitForKendoGridIdle } from '../src/reports/grid.js';
import { findContextWithVisibleSelector } from '../src/playwright/frame-resolver.js';
import { config } from '../src/config.js';

// Setup profile
const account = createGdmsAccountProfile('hmil'); // uses primary account
account.headless = false; // Show browser so user can see it and type OTP if needed

const logFile = path.resolve(config.rootDir, './scratch/captured_requests.json');
const requests = [];

console.log('1. Logging in to HMIL DMS using standard browser automation...');
const session = await loginToHmilDms(account);
const page = session.page;

console.log('2. Setting up request/response interception...');
page.on('request', async request => {
  const method = request.method();
  const url = request.url();
  if (url.includes('ndms.hmil.net') && (method === 'POST' || url.includes('ServiceController'))) {
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
  if (url.includes('ndms.hmil.net') && (request.method() === 'POST' || url.includes('ServiceController'))) {
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

console.log('3. Navigating to RO Billing Report...');
await openRoBillingReport(page);

console.log('4. Locating report context...');
const context = await findContextWithVisibleSelector(page, '#sBillDateFromDate', { timeout: 30000 });

console.log('5. Filling date range...');
await fillDate(context, '#sBillDateFromDate', '01/06/2026');
await fillDate(context, '#sBillDateToDate', '05/06/2026');

console.log('6. Clicking search and waiting for results...');
await clickSearch(context);
await waitForKendoGridIdle(context, { timeout: 30000 });

// Wait a few seconds to capture the response completely
await page.waitForTimeout(5000);

console.log('7. Closing session and saving captured logs...');
await session.close().catch(() => {});

await fs.writeFile(logFile, JSON.stringify(requests, null, 2));
console.log(`✅ Saved ${requests.length} captured network operations to: ${logFile}`);
