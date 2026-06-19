import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { sleep } from '../utils/sleep.js';

const LOGIN_URL = 'https://www.kiasafety.com/VISOF/Login.aspx';
const REPORT_URL = 'https://www.kiasafety.com/VISOF/Report/VSPolicy_SummaryReport.aspx';
const STATE_PATH = path.resolve(config.rootDir, 'storage/kia-safety-state.json');
const SCREENSHOTS_DIR = path.resolve(config.rootDir, 'logs/screenshots');
const ANALYSIS_PATH = path.resolve(config.rootDir, 'logs/calendar-analysis.txt');
const HTML_DUMP_PATH = path.resolve(config.rootDir, 'logs/calendar-page-html.txt');

const CALENDAR_BTN = '#ContentPlaceHolder1_ImageButton1';

async function ensureDirs() {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  await fs.mkdir(path.dirname(ANALYSIS_PATH), { recursive: true });
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
}

function log(...args) {
  console.log(...args);
}

async function writeAnalysis(lines) {
  await fs.writeFile(ANALYSIS_PATH, lines.join('\n'), 'utf-8');
  log(`Analysis written to ${ANALYSIS_PATH}`);
}

async function loginAndNavigate(page) {
  log('Logging in...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  await page.locator('#txtUserName').fill('JK40202');
  await sleep(400);
  await page.locator('#txtPassword').fill('Singh@4327');
  await sleep(400);
  await page.locator('#btnLogin').click();
  await sleep(4000);
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  log('Login done, URL:', page.url());

  await page.context().storageState({ path: STATE_PATH });

  const reportTab = page.locator('a.dropdown-toggle:has-text("Report")');
  await reportTab.waitFor({ state: 'visible', timeout: 15000 });
  await reportTab.click();
  await sleep(1500);

  const policySummary = page.locator('a:has-text("Policy Summary")');
  await policySummary.waitFor({ state: 'visible', timeout: 15000 });
  await policySummary.click();
  await sleep(3000);
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  log('On Policy Summary page, URL:', page.url());
}

async function inspectCalendarDiv(page, lines) {
  lines.push('\n\n========== CALENDAR DIV INSPECTION ==========');

  // Dump the full HTML of calendarDiv
  const calDivHtml = await page.evaluate(() => {
    const div = document.querySelector('#calendarDiv');
    return div ? div.outerHTML : 'NOT FOUND';
  });
  lines.push(`\n--- calendarDiv outerHTML ---\n${calDivHtml}`);

  // Dump topBar
  const topBarHtml = await page.evaluate(() => {
    const div = document.querySelector('#topBar');
    return div ? div.outerHTML : 'NOT FOUND';
  });
  lines.push(`\n--- topBar outerHTML ---\n${topBarHtml}`);

  // Structured analysis of calendarDiv
  const calStructure = await page.evaluate(() => {
    const div = document.querySelector('#calendarDiv');
    if (!div) return { found: false };

    function walk(el, depth = 0) {
      if (depth > 6) return null;
      const tag = el.tagName.toLowerCase();
      const obj = {
        tag,
        id: el.id || '',
        cls: el.className || '',
        text: (el.textContent || '').trim().slice(0, 100),
        children: []
      };
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        obj.rect = `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
      }
      for (const child of el.children) {
        const childObj = walk(child, depth + 1);
        if (childObj) obj.children.push(childObj);
      }
      return obj;
    }

    return { found: true, tree: walk(div) };
  });

  lines.push(`\n--- calendarDiv tree ---\n${JSON.stringify(calStructure, null, 2)}`);

  // Get all clickable elements inside calendarDiv (or that were added by the popup)
  const clickables = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('#calendarDiv a, #calendarDiv td, #calendarDiv input, #calendarDiv button, #calendarDiv span[onclick], #topBar a, #topBar td, #topBar input, #topBar button, #topBar span[onclick]').forEach(el => {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim();
      if (rect.width > 0 && rect.height > 0 && text) {
        result.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: el.className || '',
          text: text.slice(0, 60),
          onclick: el.getAttribute('onclick') || '',
          href: el.getAttribute('href') || '',
          rect: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
        });
      }
    });
    return result;
  });

  lines.push(`\n--- Clickable elements in calendar ---`);
  if (clickables.length) {
    clickables.forEach(el => {
      lines.push(`  <${el.tag}> id="${el.id}" cls="${el.cls}" text="${el.text}" onclick="${el.onclick}" href="${el.href}" rect=${el.rect}`);
    });
  } else {
    lines.push('  (none found - calendar may be dynamically generated by JavaScript)');
  }

  // Get ALL child elements of calendarDiv
  const allCalChildren = await page.evaluate(() => {
    const div = document.querySelector('#calendarDiv');
    if (!div) return [];
    const all = div.querySelectorAll('*');
    return Array.from(all).map(el => {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim().slice(0, 60);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: el.className || '',
        text,
        visible: rect.width > 0 && rect.height > 0,
        rect: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        onclick: el.getAttribute('onclick') || ''
      };
    });
  });

  lines.push(`\n--- All children of calendarDiv (${allCalChildren.length}) ---`);
  allCalChildren.forEach(el => {
    if (el.visible) {
      lines.push(`  <${el.tag}> id="${el.id}" cls="${el.cls}" text="${el.text}" onclick="${el.onclick}" rect=${el.rect}`);
    }
  });

  return calDivHtml;
}

async function interactWithCalendar(page, lines) {
  lines.push('\n\n========== CALENDAR INTERACTION ==========');

  // Step 1: Click on the month/year header to switch to month picker mode
  // In ASP.NET calendar, the title is usually rendered as an anchor with the month/year text
  // Select all anchor tags inside the calendar area that contain month/year info
  const titleInfo = await page.evaluate(() => {
    const calDiv = document.querySelector('#calendarDiv');
    if (!calDiv) return [];

    const anchors = calDiv.querySelectorAll('a, td, span');
    const result = [];
    anchors.forEach(a => {
      const text = a.textContent.trim();
      const rect = a.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && text) {
        result.push({
          tag: a.tagName.toLowerCase(),
          id: a.id || '',
          cls: a.className || '',
          text: text.slice(0, 40),
          onclick: a.getAttribute('onclick') || '',
          href: a.getAttribute('href') || '',
          x: rect.x, y: rect.y, w: rect.width, h: rect.height
        });
      }
    });
    return result;
  });

  lines.push('\n--- Elements in calendar area ---');
  titleInfo.forEach(el => {
    lines.push(`  <${el.tag}> id="${el.id}" cls="${el.cls}" text="${el.text}" onclick="${el.onclick.slice(0, 120)}" pos=${Math.round(el.x)},${Math.round(el.y)} size=${Math.round(el.w)}x${Math.round(el.h)}`);
  });

  // Find the title element (shows month/year - usually contains text like "June 2026")
  const titleEl = titleInfo.find(el => /\w+ \d{4}/.test(el.text) || el.text === 'June 2026' || /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(el.text));

  if (titleEl) {
    lines.push(`\n[ACTION] Clicking title "${titleEl.text}" to toggle month/year picker...`);
    try {
      await page.locator(`#calendarDiv >> text="${titleEl.text}"`).first().click();
      await sleep(1500);

      // After clicking, calendar should show month grid
      const afterClick = await page.evaluate(() => {
        const calDiv = document.querySelector('#calendarDiv');
        if (!calDiv) return 'calendarDiv gone';
        const all = calDiv.querySelectorAll('a, td, span');
        return Array.from(all).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).map(el => ({
          tag: el.tagName.toLowerCase(),
          text: el.textContent.trim().slice(0, 30),
          onclick: (el.getAttribute('onclick') || '').slice(0, 100)
        }));
      });
      lines.push('\nAfter title click - elements:');
      afterClick.forEach(el => lines.push(`  <${el.tag}> text="${el.text}" onclick="${el.onclick}"`));

      // Try to find and click January
      const janEl = afterClick.find(el => el.text === 'January' || el.text === 'Jan');
      if (janEl) {
        lines.push(`\n[ACTION] Clicking "${janEl.text}" to select month...`);
        await page.locator(`#calendarDiv >> text="${janEl.text}"`).first().click();
        await sleep(1500);

        const afterJan = await page.evaluate(() => {
          const calDiv = document.querySelector('#calendarDiv');
          if (!calDiv) return 'calendarDiv gone';
          const all = calDiv.querySelectorAll('a, td, span');
          return Array.from(all).filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).map(el => ({
            tag: el.tagName.toLowerCase(),
            text: el.textContent.trim().slice(0, 30),
            onclick: (el.getAttribute('onclick') || '').slice(0, 100)
          }));
        });
        lines.push('\nAfter clicking January - elements:');
        afterJan.forEach(el => lines.push(`  <${el.tag}> text="${el.text}" onclick="${el.onclick}"`));

        // Try to click year 2025
        const year2025 = afterJan.find(el => el.text === '2025');
        if (year2025) {
          lines.push(`\n[ACTION] Clicking year "2025"...`);
          await page.locator(`#calendarDiv >> text="2025"`).first().click();
          await sleep(1500);

          const afterYear = await page.evaluate(() => {
            const calDiv = document.querySelector('#calendarDiv');
            if (!calDiv) return 'calendarDiv gone';
            const all = calDiv.querySelectorAll('a, td, span');
            return Array.from(all).filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }).map(el => ({
              tag: el.tagName.toLowerCase(),
              text: el.textContent.trim().slice(0, 30),
              onclick: (el.getAttribute('onclick') || '').slice(0, 100)
            }));
          });
          lines.push('\nAfter clicking 2025 - elements:');
          afterYear.forEach(el => lines.push(`  <${el.tag}> text="${el.text}" onclick="${el.onclick}"`));

          // Try to click day 1
          const day1 = afterYear.find(el => el.text === '1');
          if (day1) {
            lines.push(`\n[ACTION] Clicking day "1"...`);
            await page.locator(`#calendarDiv >> text="1"`).first().click();
            await sleep(2000);
            lines.push('\n[SUCCESS] Day 1 clicked! Checking if date was set...');
            const fromDateVal = await page.locator('#ContentPlaceHolder1_txtFromDate').inputValue();
            lines.push(`From Date value: ${fromDateVal}`);
          } else {
            // Try all clickable that are just a number
            const dayCells = afterYear.filter(el => /^\d+$/.test(el.text));
            lines.push(`\nDay cells available: ${dayCells.map(d => d.text).join(', ')}`);
            if (dayCells.length) {
              const target = dayCells.find(d => d.text === '1') || dayCells[0];
              lines.push(`[ACTION] Clicking day "${target.text}"...`);
              await page.locator(`#calendarDiv >> text="${target.text}"`).first().click();
              await sleep(2000);
              const fromDateVal = await page.locator('#ContentPlaceHolder1_txtFromDate').inputValue();
              lines.push(`From Date value: ${fromDateVal}`);
            }
          }
        } else {
          // Check what years are available
          const years = afterJan.filter(el => /^\d{4}$/.test(el.text));
          lines.push(`\nAvailable years: ${years.map(y => y.text).join(', ')}`);
        }
      } else {
        // Check for month names
        const months = afterClick.filter(el => {
          const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December',
                             'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          return monthNames.includes(el.text);
        });
        lines.push(`\nMonth elements found: ${months.map(m => `${m.text} (${m.tag})`).join(', ')}`);

        if (!months.length) {
          lines.push('\nNo months found. Trying to click all clickable non-number elements...');
          const nonNumbers = afterClick.filter(el => !/^\d+$/.test(el.text));
          for (const el of nonNumbers) {
            lines.push(`  Skipping "${el.text}" (tag: ${el.tag})`);
          }
        }
      }
    } catch (e) {
      lines.push(`Error during calendar interaction: ${e.message}`);
    }
  } else {
    lines.push('\nNo title element found. Available texts:', titleInfo.map(t => `  "${t.text}"`).join('\n'));

    // Try clicking all non-numeric links
    const nonNumeric = titleInfo.filter(el => !/^\d+$/.test(el.text) && el.tag === 'a');
    if (nonNumeric.length) {
      const target = nonNumeric[0];
      lines.push(`\n[ACTION] Clicking "${target.text}"...`);
      try {
        await page.locator(`#calendarDiv >> text="${target.text}"`).first().click();
        await sleep(1500);
        lines.push('After click - checking state...');
        const after = await page.evaluate(() => {
          const calDiv = document.querySelector('#calendarDiv');
          if (!calDiv) return 'calendarDiv gone';
          const all = calDiv.querySelectorAll('a, td, span');
          return Array.from(all).filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).map(el => ({
            tag: el.tagName.toLowerCase(),
            text: el.textContent.trim().slice(0, 30),
            onclick: (el.getAttribute('onclick') || '').slice(0, 100)
          }));
        });
        after.forEach(el => lines.push(`  <${el.tag}> text="${el.text}" onclick="${el.onclick}"`));
      } catch (e) {
        lines.push(`Error: ${e.message}`);
      }
    } else {
      lines.push('No clickable text elements found.');
    }
  }

  return lines;
}

async function main() {
  await ensureDirs();

  const sessionExists = await fs.access(STATE_PATH).then(() => true).catch(() => false);

  const browser = await chromium.launch({
    headless: true,
    slowMo: 50
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    storageState: sessionExists ? STATE_PATH : undefined
  });
  context.setDefaultTimeout(30000);

  const page = await context.newPage();
  const lines = [];

  try {
    // Navigate to report page (with session check)
    if (sessionExists) {
      log('Saved session found. Trying direct navigation...');
      try {
        await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        if (page.url().includes('Login')) {
          log('Session expired. Logging in...');
          await loginAndNavigate(page);
        }
      } catch (e) {
        log(`Direct nav failed, logging in...`);
        await loginAndNavigate(page);
      }
    } else {
      await loginAndNavigate(page);
    }

    // Ensure we're on the report page
    if (!page.url().includes('Policy_Summary')) {
      // Navigate via menu
      const reportTab = page.locator('a.dropdown-toggle:has-text("Report")');
      if (await reportTab.isVisible({ timeout: 5000 }).catch(() => false)) {
        await reportTab.click();
        await sleep(1500);
        await page.locator('a:has-text("Policy Summary")').click();
        await sleep(3000);
        await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      } else {
        throw new Error('Cannot navigate to report page');
      }
    }

    log('On Policy Summary page:', page.url());
    lines.push(`Report page URL: ${page.url()}`);

    // Dump full page HTML before clicking calendar
    const preHtml = await page.evaluate(() => document.documentElement.outerHTML);
    await fs.writeFile(HTML_DUMP_PATH + '.before.txt', preHtml, 'utf-8');

    // Click the calendar icon
    log('Clicking calendar icon...');
    const calBtn = page.locator(CALENDAR_BTN);
    await calBtn.waitFor({ state: 'visible', timeout: 10000 });
    await calBtn.click();
    log('Calendar icon clicked');
    await sleep(3000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'calendar-popup.png'), fullPage: false });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'calendar-popup-full.png'), fullPage: true });

    // Click again on the To date calendar to get more info
    // Actually first analyze the current state

    // Capture page HTML after click for reference
    const postHtml = await page.evaluate(() => document.documentElement.outerHTML);
    await fs.writeFile(HTML_DUMP_PATH + '.after.txt', postHtml, 'utf-8');

    lines.push('\n========== PAGE STATE AFTER CALENDAR CLICK ==========');
    lines.push(`URL: ${page.url()}`);

    // Check if calendar is off-screen at -500
    const calPositions = await page.evaluate(() => {
      const calFrame = document.querySelector('#CalFrame');
      const calDiv = document.querySelector('#calendarDiv');
      const topBar = document.querySelector('#topBar');
      return {
        calFrame: calFrame ? calFrame.getBoundingClientRect() : null,
        calDiv: calDiv ? calDiv.getBoundingClientRect() : null,
        topBar: topBar ? topBar.getBoundingClientRect() : null,
      };
    });
    lines.push(`\nElement positions:`);
    lines.push(`  CalFrame: ${JSON.stringify(calPositions.calFrame)}`);
    lines.push(`  calendarDiv: ${JSON.stringify(calPositions.calDiv)}`);
    lines.push(`  topBar: ${JSON.stringify(calPositions.topBar)}`);

    // Inspect the iframe
    const calFrameEl = page.locator('#CalFrame').first();
    let calFrameContent;
    try { calFrameContent = await calFrameEl.contentFrame(); } catch (e) { calFrameContent = null; }
    if (calFrameContent) {
      lines.push('\n========== IFRAME #CalFrame ==========');
      try {
        const frameUrl = calFrameContent.url();
        lines.push(`URL: ${frameUrl}`);
        const frameHtml = await calFrameContent.evaluate(() => document.documentElement.outerHTML);
        lines.push(`HTML: ${frameHtml}`);
      } catch (e) {
        lines.push(`Cannot access iframe: ${e.message}`);
      }
    } else {
      lines.push('\n#CalFrame contentFrame returned null (cross-origin)');
    }

    // Inspect the calendar Div
    await inspectCalendarDiv(page, lines);

    // Interact with the calendar
    await interactWithCalendar(page, lines);

    // Final check - see if date was selected
    const fromVal = await page.locator('#ContentPlaceHolder1_txtFromDate').inputValue().catch(() => 'N/A');
    lines.push(`\nFinal From Date value: "${fromVal}"`);

    await writeAnalysis(lines);
    log('Done!');

  } catch (error) {
    log('FATAL ERROR:', error.message);
    log(error.stack);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'calendar-error.png'), fullPage: false }).catch(() => {});
    lines.push(`\nFATAL ERROR: ${error.message}`);
    lines.push(error.stack || '');
    await writeAnalysis(lines);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
