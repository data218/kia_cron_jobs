import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { sleep } from '../utils/sleep.js';
import { config } from '../config.js';

const TARGET_URL = 'https://www.kiasafety.com/VISOF/Report/VSPolicy_SummaryReport.aspx';
const LOGIN_URL = 'https://www.kiasafety.com/VISOF/Login.aspx';
const STATE_PATH = path.resolve(config.rootDir, 'storage/kia-safety-state.json');
const SCREENSHOT_PATH = path.resolve(config.rootDir, 'logs/screenshots/after-search.png');
const HTML_PATH = path.resolve(config.rootDir, 'logs/after-search-html.txt');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function login(page) {
  console.log('Session expired, logging in...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);

  await page.locator('#txtUserName').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#txtUserName').fill('JK40202');
  await sleep(500);

  await page.locator('#txtPassword').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#txtPassword').fill('Singh@4327');
  await sleep(500);

  await page.locator('#btnLogin').click();
  await sleep(3000);
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  console.log('Login completed, URL:', page.url());

  await page.context().storageState({ path: STATE_PATH });
  console.log('Session saved');
}

async function selectDateViaCalendar(page, calendarIconSelector, day, monthIndex, year) {
  console.log(`Clicking calendar icon: ${calendarIconSelector}`);
  await page.locator(calendarIconSelector).click();
  await sleep(1500);

  await page.locator('#calendarDiv').waitFor({ state: 'visible', timeout: 10000 });

  const currentMonthText = await page.locator('#calendar_month_txt').textContent();
  const currentYearText = await page.locator('#calendar_year_txt').textContent();
  const targetMonth = MONTH_NAMES[monthIndex];
  const targetYear = String(year);

  console.log(`Calendar shows: ${currentMonthText?.trim()} ${currentYearText?.trim()}, targeting: ${targetMonth} ${targetYear}`);

  if (currentMonthText.trim() !== targetMonth) {
    console.log(`Changing month from ${currentMonthText.trim()} to ${targetMonth}`);
    await page.locator('#monthSelect').click();
    await sleep(600);
    await page.locator(`#monthDiv_${monthIndex}`).click();
    await sleep(600);
  }

  if (currentYearText.trim() !== targetYear) {
    console.log(`Changing year from ${currentYearText.trim()} to ${targetYear}`);
    await page.locator('#calendar_year_txt').click();
    await sleep(600);
    await page.locator(`#yearDiv${targetYear}`).click();
    await sleep(600);
  }

  const dayStr = String(day);
  console.log(`Clicking day ${dayStr}`);
  await page.locator('#calendarDiv table td').filter({ hasText: new RegExp(`^${dayStr}$`) }).first().click();
  await sleep(1000);
  console.log(`Date ${day} ${targetMonth} ${targetYear} selected`);
}

async function doSearch(page, startDay, startMonth, startYear, endDay, endMonth, endYear) {
  console.log(`Setting start date: ${startDay} ${MONTH_NAMES[startMonth]} ${startYear}`);
  await selectDateViaCalendar(page, '#ContentPlaceHolder1_ImageButton1', startDay, startMonth, startYear);
  await sleep(1000);

  console.log(`Setting end date: ${endDay} ${MONTH_NAMES[endMonth]} ${endYear}`);
  await selectDateViaCalendar(page, '#ContentPlaceHolder1_Img1', endDay, endMonth, endYear);
  await sleep(1000);

  console.log('Clicking Go button...');
  const loadingLocator = page.locator('#ContentPlaceHolder1_divLoading');
  const isLoaderVisible = await loadingLocator.isVisible({ timeout: 1000 }).catch(() => false);

  await page.locator('#ContentPlaceHolder1_btnSearch').click();
  await sleep(3000);
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

  if (isLoaderVisible) {
    await loadingLocator.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  }

  await sleep(2000);
  console.log('Search completed, URL:', page.url());
}

async function searchForExportElements(page) {
  const results = await page.evaluate(() => {
    const exportCandidates = [];

    function scan(el) {
      const tag = el.tagName;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        tag,
        id: el.id || '',
        className: (el.className || '').slice(0, 100),
        text: ((el.textContent || '').trim()).slice(0, 150),
        href: el.getAttribute('href') || '',
        onclick: el.getAttribute('onclick') || '',
        name: el.getAttribute('name') || '',
        value: el.getAttribute('value') || '',
        type: el.getAttribute('type') || '',
        title: el.getAttribute('title') || '',
        alt: el.getAttribute('alt') || '',
        src: el.getAttribute('src') || '',
        target: el.getAttribute('target') || '',
      };
    }

    const seen = new Set();

    // 1. Collect all links, buttons, inputs
    const allInteractive = 'a, button, input, span[onclick], img[onclick]';
    document.querySelectorAll(allInteractive).forEach(el => {
      const d = scan(el);
      if (d && !seen.has(el)) { seen.add(el); exportCandidates.push(d); }
    });

    // 2. Everything inside any UpdatePanel or grid-like container
    document.querySelectorAll('div[id*="UpdatePanel"], div[id*="updatepanel"], table[id*="gv"], table[id*="Grid"], table.grid-view, table[class*="grid"]').forEach(container => {
      container.querySelectorAll('a, button, input, span, img, td, th').forEach(el => {
        const d = scan(el);
        if (d && !seen.has(el)) { seen.add(el); exportCandidates.push(d); }
      });
    });

    // 3. All elements containing export-related text or attributes
    document.querySelectorAll('*').forEach(el => {
      const text = ((el.textContent || '').trim()).toLowerCase();
      const id = (el.id || '').toLowerCase();
      const href = (el.getAttribute('href') || '').toLowerCase();
      const onclick = (el.getAttribute('onclick') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const val = (el.getAttribute('value') || '').toLowerCase();
      const elClass = (el.className || '').toLowerCase();
      const name = (el.getAttribute('name') || '').toLowerCase();

      const isExport = text.includes('export') || text.includes('csv') || text.includes('excel') ||
        text.includes('download') || text.includes('xls') || text.includes('xlsx') ||
        text.includes('generate') || text.includes('report file') ||
        id.includes('export') || id.includes('csv') || id.includes('excel') ||
        id.includes('download') || id.includes('xls') ||
        href.includes('export') || href.includes('csv') || href.includes('excel') ||
        href.includes('download') || href.includes('.xls') ||
        onclick.includes('export') || onclick.includes('csv') || onclick.includes('excel') ||
        onclick.includes('download') || onclick.includes('.xls') ||
        title.includes('export') || title.includes('csv') || title.includes('excel') ||
        title.includes('download') ||
        val.includes('export') || val.includes('csv') || val.includes('excel') ||
        val.includes('download') ||
        elClass.includes('export') || elClass.includes('csv') || elClass.includes('excel') ||
        name.includes('export') || name.includes('csv') || name.includes('excel');

      if (isExport && !seen.has(el)) {
        const d = scan(el);
        if (d) { seen.add(el); exportCandidates.push(d); }
      }
    });

    return exportCandidates;
  });

  return results;
}

async function hasNoRecords(page) {
  const noRecordTexts = ['No records', 'No data', 'No Record', 'No record found', 'No matching records'];
  for (const text of noRecordTexts) {
    if (await page.locator(`:has-text("${text}")`).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function trySearchIteration(page, label, startDay, startMonth, startYear, endDay, endMonth, endYear) {
  console.log(`\n===== Trying search: ${label} =====`);
  await doSearch(page, startDay, startMonth, startYear, endDay, endMonth, endYear);

  const noRecords = await hasNoRecords(page);
  if (noRecords) {
    console.log('Search returned: No records found for this period.');
    return { found: false, reason: 'no-records' };
  }

  const hasGrid = await page.locator('table[id*="gv"], table[id*="Grid"], table.grid-view, table[class*="grid"]').first().isVisible({ timeout: 3000 }).catch(() => false);
  if (hasGrid) {
    const rowCount = await page.locator('table[id*="gv"] tr, table[id*="Grid"] tr, table.grid-view tr, table[class*="grid"] tr').count();
    console.log(`Data grid found with approximately ${rowCount} rows.`);
  }

  const exportElements = await searchForExportElements(page);
  console.log(`Export-related elements found: ${exportElements.length}`);

  return { found: true, elements: exportElements, noRecords };
}

async function main() {
  await fs.mkdir(path.dirname(SCREENSHOT_PATH), { recursive: true });
  await fs.mkdir(path.dirname(HTML_PATH), { recursive: true });

  const hasState = await fs.access(STATE_PATH).then(() => true).catch(() => false);

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMoMs
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    storageState: hasState ? STATE_PATH : undefined
  });
  context.setDefaultTimeout(60000);
  const page = await context.newPage();

  const allExportElements = [];

  try {
    console.log('Navigating to Policy Summary Report...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);

    const isLoginPage = await page.locator('#txtUserName').isVisible({ timeout: 3000 }).catch(() => false);
    if (isLoginPage) {
      await login(page);
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
    } else {
      console.log('Session is valid, already on page:', page.url());
    }

    await sleep(1000);

    // Try searches with different date ranges
    const searches = [
      { label: 'June 2025', sd: 1, sm: 5, sy: 2025, ed: 30, em: 5, ey: 2025 },
      { label: 'June 2026 (current month)', sd: 1, sm: 5, sy: 2026, ed: 12, em: 5, ey: 2026 },
      { label: 'March 2026', sd: 1, sm: 2, sy: 2026, ed: 31, em: 2, ey: 2026 },
    ];

    for (const s of searches) {
      const result = await trySearchIteration(page, s.label, s.sd, s.sm, s.sy, s.ed, s.em, s.ey);
      if (result.found && result.elements.length > 0) {
        allExportElements.push({ search: s.label, elements: result.elements });
      }
    }

    // Take screenshot and dump HTML from the last search state
    console.log('\n===== FINAL STATE =====');
    console.log('Taking full-page screenshot...');
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log('Screenshot saved to', SCREENSHOT_PATH);

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    await fs.writeFile(HTML_PATH, html, 'utf-8');
    console.log('HTML dumped to', HTML_PATH);

    // Final comprehensive element search on current page state
    console.log('\n========== COMPREHENSIVE PAGE ELEMENT ANALYSIS ==========');

    const updatePanelContent = await page.evaluate(() => {
      const panel = document.querySelector('#ContentPlaceHolder1_upnlAddRoles');
      if (!panel) return 'UpdatePanel not found';
      return panel.innerHTML.slice(0, 5000);
    });
    console.log('\nContentPlaceHolder1_upnlAddRoles content (first 5000 chars):\n');
    console.log(updatePanelContent);

    const allElements = await page.evaluate(() => {
      const items = [];

      document.querySelectorAll('#ContentPlaceHolder1_upnlAddRoles a, #ContentPlaceHolder1_upnlAddRoles button, #ContentPlaceHolder1_upnlAddRoles input, #ContentPlaceHolder1_upnlAddRoles span, #ContentPlaceHolder1_upnlAddRoles img, #ContentPlaceHolder1_upnlAddRoles td, #ContentPlaceHolder1_upnlAddRoles th, #ContentPlaceHolder1_upnlAddRoles div').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          items.push({
            tag: el.tagName,
            id: el.id || '',
            className: (el.className || '').slice(0, 80),
            text: ((el.textContent || '').trim()).slice(0, 100),
            href: el.getAttribute('href') || '',
            onclick: el.getAttribute('onclick') || '',
            name: el.getAttribute('name') || '',
            value: el.getAttribute('value') || '',
            type: el.getAttribute('type') || '',
            title: el.getAttribute('title') || '',
            alt: el.getAttribute('alt') || '',
            src: el.getAttribute('src') || '',
          });
        }
      });

      return items;
    });

    console.log(`\nAll visible elements inside UpdatePanel (${allElements.length}):\n`);
    for (const el of allElements) {
      console.log(`  [${el.tag}] ID="${el.id}" Class="${el.className}"`);
      if (el.text) console.log(`       Text: "${el.text}"`);
      if (el.href) console.log(`       Href: "${el.href}"`);
      if (el.onclick) console.log(`       OnClick: "${el.onclick}"`);
      if (el.value) console.log(`       Value: "${el.value}"`);
      if (el.name) console.log(`       Name: "${el.name}"`);
      if (el.type) console.log(`       Type: "${el.type}"`);
      if (el.title) console.log(`       Title: "${el.title}"`);
      if (el.alt) console.log(`       Alt: "${el.alt}"`);
      if (el.src) console.log(`       Src: "${el.src}"`);
      console.log('');
    }

    // Check page body for tables
    console.log('\n--- Tables on page ---');
    const tables = await page.evaluate(() => {
      const result = [];
      document.querySelectorAll('table').forEach(t => {
        const id = t.id || '(no id)';
        const cls = t.className || '(no class)';
        const rows = t.querySelectorAll('tr').length;
        const cols = t.querySelector('tr') ? t.querySelectorAll('tr:first-child td, tr:first-child th').length : 0;
        result.push({ id, class: cls, rows, cols });
      });
      return result;
    });
    tables.forEach(t => console.log(`  id="${t.id}" class="${t.class}" rows=${t.rows} cols=${t.cols}`));

    // Search for export-related in the full HTML
    const exportElements = await searchForExportElements(page);

    console.log('\n========== ALL EXPORT-RELATED ELEMENTS ==========');
    if (exportElements.length === 0) {
      console.log('No export-related elements found on the page.');
    } else {
      console.log(`Found ${exportElements.length} export-related element(s):\n`);
      for (const el of exportElements) {
        const matchReasons = [];
        function check(val, reason) {
          if (val.toLowerCase().includes('export') || val.toLowerCase().includes('csv') ||
              val.toLowerCase().includes('excel') || val.toLowerCase().includes('download') ||
              val.toLowerCase().includes('.xls') || val.toLowerCase().includes('xlsx') ||
              val.toLowerCase().includes('generate')) {
            matchReasons.push(`${reason}="${val.slice(0, 80)}"`);
          }
        }
        check(el.text, 'text');
        check(el.id, 'id');
        check(el.href, 'href');
        check(el.onclick, 'onclick');
        check(el.title, 'title');
        check(el.value, 'value');
        check(el.className, 'class');
        check(el.name, 'name');

        console.log(`  [${el.tag}] ID="${el.id}"`);
        console.log(`       Matched: ${matchReasons.join(', ')}`);
        if (el.href) console.log(`       Href: ${el.href}`);
        if (el.text) console.log(`       Text: "${el.text}"`);
        if (el.onclick) console.log(`       OnClick: "${el.onclick}"`);
        if (el.name) console.log(`       Name: "${el.name}"`);
        if (el.value) console.log(`       Value: "${el.value}"`);
        if (el.type) console.log(`       Type: "${el.type}"`);
        console.log('');
      }
    }
    console.log('==================================================');

  } catch (error) {
    console.error('Fatal error:', error.message);
    const errScreenshot = SCREENSHOT_PATH.replace('.png', '-error.png');
    await page.screenshot({ path: errScreenshot, fullPage: true }).catch(() => {});
    console.log('Error screenshot saved to', errScreenshot);
  } finally {
    await browser.close();
    console.log('Browser closed');
  }
}

main();
