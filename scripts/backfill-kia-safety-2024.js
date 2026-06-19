import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// === CONFIG ===
const LOGIN_URL = 'https://www.kiasafety.com/VISOF/Login.aspx';
const POLICY_SUMMARY_URL = 'https://www.kiasafety.com/VISOF/Report/VSPolicy_SummaryReport.aspx';
const USER_ID = process.env.KIA_SAFETY_USER_ID || 'JK40202';
const PASSWORD = process.env.KIA_SAFETY_PASSWORD || 'Singh@4327';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HEADLESS = (process.env.HEADLESS || 'true') === 'true';
const STATE_PATH = path.resolve('storage/kia-safety-state.json');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function humanPause(ms = 300) {
  return new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 400)));
}

// === SUPABASE CLIENT ===
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function saveToSupabase(rows) {
  if (!rows.length) return { inserted: 0, total: 0 };
  
  // Map header names to normalized column names
  const headers = [
    'Sno','BRAND','State','Location','DealerCode','Dealer',
    'policy_effective_date','Policy_expiry_date','InsuranceCompany',
    'PolicyNo','PolicyType','Class','ProductType','Model','FuelType',
    'Variant','VinNo','EngineNo','Create_Date','PaymentGenerated',
    'PaymentNo','PaymentMode','ODDiscount','Cancelled','Cancelled_Date',
    'Endorsed','ChequeNo','TotalIDV','NetODPremiumA','NetPremium',
    'IGST','CGST','SGST','UGST','GrossPremium','CUSTOMER_NAME',
    'Package_Name','NCB_SLAB_PER','VEH_REGIST_NO','MFG_YEAR',
    'ACH_CC_Status','Prev_POLICY_NO','Prev_IC_NAME','Quotation_No',
    'IS_LONGTERM','IS_CRP'
  ];

  // Normalize headers to column names
  function colName(h) {
    return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'col';
  }

  const columns = headers.map(h => ({ header: h, name: colName(h) }));

  // Build insert data with row_hash
  const insertData = rows.map(row => {
    const entry = { uploaded_at: new Date().toISOString() };
    const hashParts = [];
    for (const col of columns) {
      const val = (row[col.header] || '').trim();
      entry[col.name] = val || null;
      if (val && !['sno', 'row_hash'].includes(col.name)) {
        hashParts.push(`${col.name}=${val}`);
      }
    }
    // row_hash: sha256 of sorted key=value pairs (excluding sno)
    const hash = require('crypto').createHash('sha256').update(hashParts.sort().join('&')).digest('hex');
    entry.row_hash = hash;
    return entry;
  });

  // Deduplicate by row_hash
  const seen = new Set();
  const unique = [];
  for (const d of insertData) {
    if (!seen.has(d.row_hash)) {
      seen.add(d.row_hash);
      unique.push(d);
    }
  }

  console.log(`  Inserting ${unique.length} unique rows (${insertData.length - unique.length} duplicates filtered)`);

  // Batch upsert
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    try {
      const { data, error } = await supabase
        .from('kia_insurance')
        .upsert(batch, { onConflict: 'row_hash', ignoreDuplicates: false })
        .select('row_hash');
      if (error) {
        console.error(`  Supabase error: ${error.message}`);
        throw error;
      }
      inserted += data?.length || 0;
      console.log(`  Batch ${Math.floor(i / batchSize) + 1}: ${data?.length || 0} inserted`);
    } catch (e) {
      console.error(`  Batch failed: ${e.message}`);
      throw e;
    }
  }

  return { inserted, total: rows.length };
}

// === LOGIN ===
async function login(page) {
  console.log('Opening login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanPause(2000);

  await page.locator('#txtUserName').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#txtUserName').fill(USER_ID);
  await humanPause(500);

  await page.locator('#txtPassword').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#txtPassword').fill(PASSWORD);
  await humanPause(500);

  await page.locator('#btnLogin').click();
  await humanPause(4000);
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  console.log('Login successful, URL:', page.url());

  await page.context().storageState({ path: STATE_PATH });
}

// === NAVIGATE TO POLICY SUMMARY ===
async function navigateToPolicySummary(page) {
  const url = page.url();
  if (url.includes('VSPolicy_SummaryReport.aspx')) {
    console.log('Already on Policy Summary page');
    return;
  }

  console.log('Navigating via menu to Policy Summary...');
  const reportTab = page.locator('a.dropdown-toggle:has-text("Report")');
  await reportTab.waitFor({ state: 'visible', timeout: 15000 });
  await reportTab.click();
  await humanPause(1500);

  const policySummary = page.locator('a:has-text("Policy Summary")');
  await policySummary.waitFor({ state: 'visible', timeout: 15000 });
  await policySummary.click();
  await humanPause(3000);
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  console.log('On Policy Summary page, URL:', page.url());
}

// === CALENDAR DATE SELECTION ===
async function selectDateViaCalendar(page, calendarIconSelector, day, monthIndex, year) {
  console.log(`  Opening calendar for ${day} ${MONTH_NAMES[monthIndex]} ${year}`);
  await page.locator(calendarIconSelector).click();
  await humanPause(1500);

  await page.locator('#calendarDiv').waitFor({ state: 'visible', timeout: 10000 });

  const currentMonthText = await page.locator('#calendar_month_txt').textContent();
  const currentYearText = await page.locator('#calendar_year_txt').textContent();
  const targetMonth = MONTH_NAMES[monthIndex];
  const targetYear = String(year);

  if (currentMonthText.trim() !== targetMonth) {
    console.log(`    Changing month: ${currentMonthText.trim()} -> ${targetMonth}`);
    await page.locator('#monthSelect').click();
    await humanPause(600);
    await page.locator(`#monthDiv_${monthIndex}`).click();
    await humanPause(600);
  }

  if (currentYearText.trim() !== targetYear) {
    console.log(`    Changing year: ${currentYearText.trim()} -> ${targetYear}`);
    await page.locator('#calendar_year_txt').click();
    await humanPause(600);
    await page.locator(`#yearDiv${targetYear}`).click();
    await humanPause(600);
  }

  const dayStr = String(day);
  await page.locator('#calendarDiv table td').filter({ hasText: new RegExp(`^${dayStr}$`) }).first().click();
  await humanPause(1000);
  console.log(`    Selected: ${day} ${targetMonth} ${targetYear}`);
}

// === EXTRACT DATA FROM POPUP PAGE ===
async function extractGridFromPopup(popupPage) {
  console.log('  Extracting data from popup page...');
  await humanPause(2000);

  // Try to find the grid table
  let grid = null;
  const gridSelectors = [
    'table[id*="gvPolicy"]', 'table[id*="GridView"]', 'table[id*="gvData"]',
    'table[id*="gv"]', 'table[class*="grid"]', 'table[class*="GridView"]',
    '#ContentPlaceHolder1_gvPolicy', '#ContentPlaceHolder1_GridView1',
    '#ContentPlaceHolder1_gvData', 'table[id*="Policy"]', 'table'
  ];

  for (const selector of gridSelectors) {
    const el = popupPage.locator(selector).first();
    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) continue;
    const rows = await el.locator('tr').count().catch(() => 0);
    if (rows > 2) {  // header + at least 1 data row
      grid = el;
      console.log(`  Found grid: ${selector} (${rows} rows)`);
      break;
    }
  }

  if (!grid) {
    // Last resort: any table with visible rows
    const tables = await popupPage.locator('table').all();
    for (const el of tables) {
      const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;
      const rows = await el.locator('tr').count().catch(() => 0);
      if (rows > 2) {
        grid = el;
        console.log(`  Found grid (fallback): ${rows} rows`);
        break;
      }
    }
  }

  if (!grid) {
    const html = await popupPage.evaluate(() => document.body.innerHTML.substring(0, 3000));
    console.log('  Popup body HTML:', html.substring(0, 1000));
    throw new Error('No grid table found on popup page');
  }

  // Extract headers
  const headers = [];
  const headerCells = await grid.locator('thead tr th, thead tr td').all();
  if (headerCells.length > 0) {
    for (const cell of headerCells) {
      headers.push(await cell.textContent().then(t => (t || '').trim()));
    }
  } else {
    // Fallback: first row as headers
    const firstRowCells = await grid.locator('tr').first().locator('td, th').all();
    for (const cell of firstRowCells) {
      headers.push(await cell.textContent().then(t => (t || '').trim()));
    }
  }

  // Extract data rows
  const rows = [];
  const dataRows = await grid.locator('tr').all();
  // Skip header row
  const startIndex = headerCells.length > 0 ? 0 : 1;
  for (let i = startIndex; i < dataRows.length; i++) {
    const cells = await dataRows[i].locator('td').all();
    if (cells.length === 0) continue;
    
    const row = {};
    let hasContent = false;
    for (let j = 0; j < cells.length && j < headers.length; j++) {
      const val = await cells[j].textContent().then(t => (t || '').trim());
      row[headers[j]] = val;
      if (val) hasContent = true;
    }
    if (hasContent) rows.push(row);
  }

  console.log(`  Extracted ${rows.length} data rows with ${headers.length} columns`);
  return { headers, rows };
}

// === PROCESS A MONTH ===
async function processMonth(page, context, year, month) {
  const monthIndex = month - 1;
  const monthName = MONTH_NAMES[monthIndex];
  const label = `${year}-${String(month).padStart(2, '0')}`;
  console.log(`\n========== ${monthName} ${year} (${label}) ==========`);
  
  const startDate = new Date(year, monthIndex, 1);
  const endDate = new Date(year, monthIndex + 1, 0); // last day of month
  
  // Set From date
  console.log('Setting From date...');
  await selectDateViaCalendar(page, '#ContentPlaceHolder1_ImageButton1', 1, monthIndex, year);
  await humanPause(1000);
  
  // Set To date
  console.log('Setting To date...');
  await selectDateViaCalendar(page, '#ContentPlaceHolder1_Img1', endDate.getDate(), monthIndex, year);
  await humanPause(1000);
  
  // Click Go
  console.log('Clicking Go...');
  const beforePages = context.pages().length;
  await page.locator('#ContentPlaceHolder1_btnSearch').click();
  await humanPause(5000);
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  
  // Wait for popup to open
  await humanPause(3000);
  const allPages = context.pages();
  console.log(`  Pages open: ${allPages.length} (was ${beforePages})`);
  
  // Find the popup page
  let popupPage = null;
  for (const p of allPages) {
    const pu = p.url();
    console.log(`  Page: ${pu.substring(0, 120)}`);
    if (pu.includes('VSPolicy_SummaryReportList.aspx')) {
      popupPage = p;
      console.log('  -> Found result popup!');
    }
  }

  if (!popupPage) {
    // Check for "no records" on main page
    const noRecordTexts = ['No records', 'No data', 'No Record', 'No record found', '0 records'];
    for (const text of noRecordTexts) {
      if (await page.locator(`:has-text("${text}")`).first().isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log(`  No records for ${label}`);
        return null;
      }
    }
    // Maybe the page navigated instead of opening a popup
    if (page.url().includes('VSPolicy_SummaryReportList.aspx')) {
      popupPage = page;
      console.log('  Page navigated to result page');
    } else {
      console.log(`  No result popup found for ${label}`);
      return null;
    }
  }

  // Extract data
  try {
    const data = await extractGridFromPopup(popupPage);
    
    // Close popup if it's not the main page
    if (popupPage !== page) {
      await popupPage.close().catch(() => {});
    }
    
    // Wait for popup to fully close
    await humanPause(1000);
    
    // Navigate main page back to fresh state (make sure no stale popup)
    // Just ensure we're on the main page
    if (!page.url().includes('VSPolicy_SummaryReport.aspx') && !page.url().includes('Login')) {
      console.log('  Navigating back to policy summary...');
      await page.goto(POLICY_SUMMARY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await humanPause(2000);
    }
    
    return data;
  } catch (e) {
    console.log(`  Error extracting data for ${label}: ${e.message}`);
    // Close popup if any
    if (popupPage && popupPage !== page) {
      await popupPage.close().catch(() => {});
    }
    return null;
  }
}

// === MAIN ===
async function main() {
  console.log('=== KIA SAFETY 2024 BACKFILL ===\n');
  
  // Ensure storage dir exists
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  
  // Launch browser
  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: 0
  });
  
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 }
  });
  context.setDefaultTimeout(60000);
  const page = await context.newPage();
  
  // Handle dialogs (alerts) automatically
  context.on('page', (p) => {
    p.on('dialog', async (dialog) => {
      console.log(`  [Dialog on popup]: ${dialog.message().substring(0, 100)}`);
      await dialog.dismiss();
    });
  });
  page.on('dialog', async (dialog) => {
    console.log(`  [Dialog]: ${dialog.message().substring(0, 100)}`);
    await dialog.dismiss();
  });
  
  let allMonthData = [];
  const failedMonths = [];
  
  try {
    // Login
    await login(page);
    
    // Navigate to policy summary
    await navigateToPolicySummary(page);
    
    // Process each month of 2024
    for (let month = 1; month <= 12; month++) {
      const result = await processMonth(page, context, 2024, month);
      if (result && result.rows.length > 0) {
        console.log(`  >> ${result.rows.length} rows extracted for ${MONTH_NAMES[month - 1]} 2024`);
        allMonthData.push(...result.rows);
      } else {
        console.log(`  >> No data for ${MONTH_NAMES[month - 1]} 2024`);
        failedMonths.push(MONTH_NAMES[month - 1]);
      }
    }
    
    console.log(`\n========================================`);
    console.log(`Total rows extracted: ${allMonthData.length}`);
    console.log(`Failed months: ${failedMonths.join(', ') || 'none'}`);
    
    // Save to Supabase
    if (allMonthData.length > 0) {
      console.log(`\nSaving ${allMonthData.length} rows to Supabase...`);
      const result = await saveToSupabase(allMonthData);
      console.log(`\n=== COMPLETE ===`);
      console.log(`Total rows extracted: ${result.total}`);
      console.log(`Rows inserted: ${result.inserted}`);
      console.log(`Rows duplicate/skipped: ${result.total - result.inserted}`);
      console.log(`Failed months: ${failedMonths.join(', ') || 'none'}`);
    } else {
      console.log('\nNo data extracted for any month.');
    }
    
  } catch (error) {
    console.error('\nFATAL ERROR:', error.message);
    console.error(error.stack);
    // Save whatever we have so far
    if (allMonthData.length > 0) {
      console.log(`\nSaving ${allMonthData.length} rows collected before error...`);
      await saveToSupabase(allMonthData).catch(e => console.error('Save error:', e.message));
    }
  } finally {
    await browser.close();
    console.log('Browser closed');
  }
}

main();
