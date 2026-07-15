import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { sleep } from '../utils/sleep.js';

const LOGIN_URL = 'https://www.kiasafety.com/VISOF/Login.aspx';
const REPORT_URL = 'https://www.kiasafety.com/VISOF/Report/VSPolicy_SummaryReport.aspx';
const STATE_PATH = path.resolve(config.rootDir, 'storage/kia-safety-state.json');
const SCREENSHOTS_DIR = path.resolve(config.rootDir, 'logs/screenshots');
const OUTPUT_PATH = path.resolve(config.rootDir, 'logs/calendar-examine-2.txt');

const CALENDAR_BTN = '#ContentPlaceHolder1_ImageButton1';

async function ensureDirs() {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
}

async function loginAndNavigate(page) {
  console.log('Logging in...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  await page.locator('#txtUserName').fill('JK40202');
  await sleep(400);
  await page.locator('#txtPassword').fill('Abhi@123');
  await sleep(400);
  await page.locator('#btnLogin').click();
  await sleep(4000);
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
  console.log('Login done, URL:', page.url());

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
  console.log('On Policy Summary page, URL:', page.url());
}

async function main() {
  await ensureDirs();

  const sessionExists = await fs.access(STATE_PATH).then(() => true).catch(() => false);
  console.log('Session exists:', sessionExists);

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
    if (sessionExists) {
      console.log('Saved session found. Trying direct navigation...');
      try {
        await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        if (page.url().includes('Login')) {
          console.log('Session expired. Logging in...');
          await loginAndNavigate(page);
        }
      } catch (e) {
        console.log('Direct nav failed, logging in...');
        await loginAndNavigate(page);
      }
    } else {
      await loginAndNavigate(page);
    }

    if (!page.url().includes('Policy_Summary')) {
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

    console.log('On Policy Summary page:', page.url());
    lines.push(`Report page URL: ${page.url()}`);

    // ========== STEP 5: Get iframe element for #CalFrame ==========
    lines.push('\n========== STEP 5: IFRAME #CalFrame ==========');

    const calFrameHandle = await page.$('#CalFrame');
    if (calFrameHandle) {
      const frameBox = await calFrameHandle.boundingBox();
      lines.push(`CalFrame bounding box: ${JSON.stringify(frameBox)}`);
      const frameSrc = await calFrameHandle.getAttribute('src');
      lines.push(`CalFrame src: ${frameSrc || 'none'}`);

      // ========== STEP 6: Try to get contentFrame ==========
      lines.push('\n========== STEP 6: Accessing iframe content ==========');
      let frame = null;
      try {
        frame = await calFrameHandle.contentFrame();
      } catch (e) {
        lines.push(`contentFrame() threw: ${e.message}`);
      }

      if (frame) {
        // ========== STEP 7: Dump iframe content ==========
        lines.push('\n========== STEP 7: Iframe accessible - dumping content ==========');
        try {
          const frameUrl = frame.url();
          lines.push(`Frame URL: ${frameUrl}`);
          const frameHtml = await frame.evaluate(() => document.documentElement.outerHTML);
          lines.push(`\n--- Frame HTML (${frameHtml.length} chars) ---\n${frameHtml}`);
        } catch (e) {
          lines.push(`Frame evaluate error: ${e.message}`);
        }
      } else {
        lines.push('\ncontentFrame() returned null (cross-origin or inaccessible)');
      }
    } else {
      lines.push('#CalFrame element not found in DOM');
    }

    // ========== STEP 8: If cross-origin, click calendar icon and examine popup ==========
    lines.push('\n========== STEP 8: Clicking calendar icon and examining popup ==========');

    // 8a: Click the calendar icon for From Date
    console.log('Clicking calendar icon...');
    const calBtn = page.locator(CALENDAR_BTN);
    await calBtn.waitFor({ state: 'visible', timeout: 10000 });
    await calBtn.click();
    console.log('Calendar icon clicked');
    // 8b: Wait 2 seconds
    await sleep(2000);

    // 8c+d: Find the visible calendar div
    console.log('Looking for calendar div...');
    const calInfo = await page.evaluate(() => {
      const results = {};

      // Check calendarDiv
      const calDiv = document.querySelector('#calendarDiv');
      if (calDiv) {
        const r = calDiv.getBoundingClientRect();
        results.calendarDiv = {
          found: true,
          tag: calDiv.tagName.toLowerCase(),
          id: calDiv.id || '',
          cls: calDiv.className || '',
          rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          visible: r.width > 0 && r.height > 0,
          outerHTML: calDiv.outerHTML,
          innerHTML: calDiv.innerHTML
        };
      } else {
        results.calendarDiv = { found: false };
      }

      // Check topBar
      const topBar = document.querySelector('#topBar');
      if (topBar) {
        const r = topBar.getBoundingClientRect();
        results.topBar = {
          found: true,
          tag: topBar.tagName.toLowerCase(),
          id: topBar.id || '',
          cls: topBar.className || '',
          rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          visible: r.width > 0 && r.height > 0,
          outerHTML: topBar.outerHTML
        };
      } else {
        results.topBar = { found: false };
      }

      // Look for any visible positioned divs that might be the calendar
      const allDivs = document.querySelectorAll('div');
      const visibleCalendars = [];
      allDivs.forEach(d => {
        const r = d.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.x > 0 && r.y > 0) {
          const text = (d.textContent || '').trim().slice(0, 200);
          if (text && (text.match(/January|February|March|April|May|June|July|August|September|October|November|December/) ||
              text.match(/\d{4}/) || d.id.toLowerCase().includes('cal') || d.className.toLowerCase().includes('cal'))) {
            visibleCalendars.push({
              id: d.id || '',
              cls: d.className || '',
              rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
              text: text.slice(0, 100),
              outerHTML: d.outerHTML.length > 2000 ? d.outerHTML.slice(0, 2000) + '...' : d.outerHTML
            });
          }
        }
      });
      results.visibleCalendars = visibleCalendars;

      // Look for any iframes that appeared
      const iframes = document.querySelectorAll('iframe');
      results.iframes = Array.from(iframes).map(f => {
        const r = f.getBoundingClientRect();
        return {
          id: f.id || '',
          src: f.src || '',
          rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          visible: r.width > 0 && r.height > 0
        };
      });

      // Also search for the CalFrame iframe position again
      const calF = document.querySelector('#CalFrame');
      if (calF) {
        const r = calF.getBoundingClientRect();
        results.calFrame2 = {
          rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          src: calF.src || ''
        };
      }

      return results;
    });

    lines.push('\n--- Calendar div info ---');
    lines.push(JSON.stringify(calInfo, null, 2));

    // 8e: Dump full HTML of calendarDiv and all children
    const calDivDetail = await page.evaluate(() => {
      const div = document.querySelector('#calendarDiv');
      if (!div) return { found: false };

      function getDetail(el, depth = 0) {
        if (depth > 8) return { tag: el.tagName, truncated: true };
        const r = el.getBoundingClientRect();
        const obj = {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: el.className || typeof el.className === 'object' ? el.className.baseVal || '' : '',
          text: (el.textContent || '').trim().slice(0, 80),
          rect: r.width > 0 && r.height > 0 ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : null,
          onclick: el.getAttribute('onclick') || '',
          href: el.getAttribute('href') || '',
          name: el.getAttribute('name') || '',
          value: el.getAttribute('value') || '',
          type: el.getAttribute('type') || '',
          children: []
        };
        for (const child of el.children) {
          obj.children.push(getDetail(child, depth + 1));
        }
        return obj;
      }

      return {
        found: true,
        outerHTML: div.outerHTML,
        tree: getDetail(div)
      };
    });

    lines.push('\n--- calendarDiv full detail ---');
    lines.push(JSON.stringify(calDivDetail, null, 2));

    // 8f: Look for elements with month names, year numbers, navigation arrows, date numbers
    lines.push('\n--- 8f: Looking for month/year/nav/date elements ---');
    const calElements = await page.evaluate(() => {
      const div = document.querySelector('#calendarDiv');
      if (!div) return { found: false };

      const allElements = div.querySelectorAll('*');
      const results = [];

      allElements.forEach(el => {
        const text = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        if (!text || r.width === 0 || r.height === 0) return;

        const tag = el.tagName.toLowerCase();
        const rect = `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;

        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December',
                           'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        const isMonth = monthNames.includes(text);
        const isYear = /^\d{4}$/.test(text);
        const isNav = ['<', '>', '<<', '>>', '«', '»', '‹', '›', '\u00AB', '\u00BB', '\u2039', '\u203A'].includes(text) ||
                       text.includes('<') || text.includes('>') || text.includes('«') || text.includes('»');
        const isDayNum = /^\d{1,2}$/.test(text) && !isMonth && !isYear;
        const isTitle = monthNames.some(m => text.includes(m)) && /\d{4}/.test(text);

        if (isMonth || isYear || isNav || isDayNum || isTitle) {
          results.push({
            tag,
            id: el.id || '',
            cls: el.className || '',
            text,
            type: isMonth ? 'month' : isYear ? 'year' : isNav ? 'nav' : isDayNum ? 'day' : 'title',
            onclick: el.getAttribute('onclick') || '',
            href: el.getAttribute('href') || '',
            rect
          });
        }
      });

      return { found: true, elements: results };
    });

    lines.push(JSON.stringify(calElements, null, 2));

    // 8g: Look for select and option tags
    lines.push('\n--- 8g: Looking for select/option tags ---');
    const selectInfo = await page.evaluate(() => {
      const div = document.querySelector('#calendarDiv');
      if (!div) return { found: false };

      const selects = div.querySelectorAll('select');
      return {
        found: selects.length > 0,
        count: selects.length,
        selects: Array.from(selects).map(s => {
          const r = s.getBoundingClientRect();
          return {
            id: s.id || '',
            name: s.getAttribute('name') || '',
            cls: s.className || '',
            rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
            visible: r.width > 0 && r.height > 0,
            options: Array.from(s.options).map(o => ({
              text: o.text,
              value: o.value,
              selected: o.selected
            }))
          };
        })
      };
    });

    lines.push(JSON.stringify(selectInfo, null, 2));

    // 8h: Try clicking on the month/year title area to see if it changes the view
    lines.push('\n--- 8h: Clicking on month/year title area ---');

    // First let's see exactly what's in the calendar
    const titleElements = await page.evaluate(() => {
      const div = document.querySelector('#calendarDiv');
      if (!div) return [];
      const all = div.querySelectorAll('a, td, span, div');
      const visible = [];
      all.forEach(el => {
        const text = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        if (text && r.width > 0 && r.height > 0) {
          visible.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            cls: el.className || '',
            text: text.slice(0, 60),
            onclick: el.getAttribute('onclick') || '',
            href: el.getAttribute('href') || '',
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
          });
        }
      });
      return visible;
    });

    lines.push('\nAll visible elements in calendarDiv:');
    titleElements.forEach(el => {
      lines.push(`  <${el.tag}> id="${el.id}" cls="${el.cls}" text="${el.text}" onclick="${(el.onclick || '').slice(0, 150)}" href="${el.href}" pos=${el.x},${el.y} size=${el.w}x${el.h}`);
    });

    // Find title element - text like "June 2026" or similar
    const monthYearRegex = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i;
    const titleEl = titleElements.find(el => monthYearRegex.test(el.text));

    if (titleEl) {
      lines.push(`\n[ACTION] Found title: "${titleEl.text}" at (${titleEl.x}, ${titleEl.y}). Clicking it...`);
      try {
        await page.locator(`#calendarDiv >> text="${titleEl.text}"`).first().click();
        await sleep(1500);
        lines.push('After title click - checking state:');

        const afterTitle = await page.evaluate(() => {
          const div = document.querySelector('#calendarDiv');
          if (!div) return 'calendarDiv gone';
          const all = div.querySelectorAll('a, td, span, div');
          return Array.from(all).filter(el => {
            const r = el.getBoundingClientRect();
            return (el.textContent || '').trim() && r.width > 0 && r.height > 0;
          }).map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            cls: el.className || '',
            text: (el.textContent || '').trim().slice(0, 40),
            onclick: (el.getAttribute('onclick') || '').slice(0, 150)
          }));
        });

        if (typeof afterTitle === 'string') {
          lines.push(`  ${afterTitle}`);
        } else {
          afterTitle.forEach(el => lines.push(`  <${el.tag}> id="${el.id}" cls="${el.cls}" text="${el.text}" onclick="${el.onclick}"`));
        }

        // Now try clicking on a month name if we see them
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const monthEl = afterTitle && Array.isArray(afterTitle) ? afterTitle.find(el => monthNames.includes(el.text)) : null;

        if (monthEl) {
          lines.push(`\n[ACTION] Found month: "${monthEl.text}". Clicking it...`);
          try {
            await page.locator(`#calendarDiv >> text="${monthEl.text}"`).first().click();
            await sleep(1500);

            const afterMonth = await page.evaluate(() => {
              const div = document.querySelector('#calendarDiv');
              if (!div) return 'calendarDiv gone';
              const all = div.querySelectorAll('a, td, span, div');
              return Array.from(all).filter(el => {
                const r = el.getBoundingClientRect();
                return (el.textContent || '').trim() && r.width > 0 && r.height > 0;
              }).map(el => ({
                tag: el.tagName.toLowerCase(),
                text: (el.textContent || '').trim().slice(0, 40),
                onclick: (el.getAttribute('onclick') || '').slice(0, 150)
              }));
            });

            if (typeof afterMonth === 'string') {
              lines.push(`  ${afterMonth}`);
            } else {
              afterMonth.forEach(el => lines.push(`  <${el.tag}> text="${el.text}" onclick="${el.onclick}"`));
            }

            // Try clicking a year
            const yearEl = afterMonth && Array.isArray(afterMonth) ? afterMonth.find(el => /^\d{4}$/.test(el.text)) : null;
            if (yearEl) {
              lines.push(`\n[ACTION] Found year: "${yearEl.text}". Clicking it...`);
              try {
                await page.locator(`#calendarDiv >> text="${yearEl.text}"`).first().click();
                await sleep(1500);

                const afterYear = await page.evaluate(() => {
                  const div = document.querySelector('#calendarDiv');
                  if (!div) return 'calendarDiv gone';
                  const all = div.querySelectorAll('a, td, span, div');
                  return Array.from(all).filter(el => {
                    const r = el.getBoundingClientRect();
                    return (el.textContent || '').trim() && r.width > 0 && r.height > 0;
                  }).map(el => ({
                    tag: el.tagName.toLowerCase(),
                    text: (el.textContent || '').trim().slice(0, 40),
                    onclick: (el.getAttribute('onclick') || '').slice(0, 150)
                  }));
                });

                if (typeof afterYear === 'string') {
                  lines.push(`  ${afterYear}`);
                } else {
                  afterYear.forEach(el => lines.push(`  <${el.tag}> text="${el.text}" onclick="${el.onclick}"`));
                }
              } catch (e) {
                lines.push(`  Error clicking year: ${e.message}`);
              }
            }
          } catch (e) {
            lines.push(`  Error clicking month: ${e.message}`);
          }
        } else {
          lines.push('  No month elements found after title click');
          // Look for any clickable text
          const clickableTexts = afterTitle && Array.isArray(afterTitle) ? afterTitle.filter(el => el.text.length > 0 && !/^\d+$/.test(el.text)).map(el => el.text) : [];
          lines.push(`  Available clickable texts: ${clickableTexts.join(', ')}`);
        }
      } catch (e) {
        lines.push(`  Error clicking title: ${e.message}`);
      }
    } else {
      lines.push('\nNo month/year title found. Trying to click all anchors...');
      const anchors = titleElements.filter(el => el.tag === 'a');
      if (anchors.length) {
        anchors.forEach(a => lines.push(`  Anchor: text="${a.text}" onclick="${(a.onclick || '').slice(0, 150)}" href="${a.href}"`));
        // Try clicking first anchor
        const firstAnchor = anchors[0];
        lines.push(`\n[ACTION] Clicking first anchor: "${firstAnchor.text}"...`);
        try {
          await page.locator(`#calendarDiv >> text="${firstAnchor.text}"`).first().click();
          await sleep(1500);
          const afterClick = await page.evaluate(() => {
            const div = document.querySelector('#calendarDiv');
            if (!div) return 'gone';
            return Array.from(div.querySelectorAll('*')).filter(el => {
              const r = el.getBoundingClientRect();
              return (el.textContent || '').trim() && r.width > 0 && r.height > 0;
            }).map(el => ({
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || '').trim().slice(0, 40)
            }));
          });
          if (typeof afterClick === 'string') {
            lines.push(`  ${afterClick}`);
          } else {
            afterClick.forEach(el => lines.push(`  <${el.tag}> text="${el.text}"`));
          }
        } catch (e) {
          lines.push(`  Error: ${e.message}`);
        }
      } else {
        lines.push('  No anchors found in calendar div');
      }
    }

    // 8i: Take screenshot
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'calendar-popup-2.png'),
      fullPage: false
    });
    console.log('Screenshot saved');

    // Also dump the full page HTML near the calendar area
    const pageHtmlAroundCalendar = await page.evaluate(() => {
      const calDiv = document.querySelector('#calendarDiv');
      if (!calDiv) return 'calendarDiv not found';
      return calDiv.outerHTML;
    });
    lines.push('\n\n========== FINAL calendarDiv outerHTML ==========');
    lines.push(pageHtmlAroundCalendar);

    await fs.writeFile(OUTPUT_PATH, lines.join('\n'), 'utf-8');
    console.log(`Analysis written to ${OUTPUT_PATH}`);
    console.log('Done!');

  } catch (error) {
    console.log('FATAL ERROR:', error.message);
    console.log(error.stack);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'calendar-error-2.png'), fullPage: false }).catch(() => {});
    lines.push(`\nFATAL ERROR: ${error.message}`);
    lines.push(error.stack || '');
    await fs.writeFile(OUTPUT_PATH, lines.join('\n'), 'utf-8').catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
