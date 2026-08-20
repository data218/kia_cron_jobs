// Logs into the HIIB insurance portal and dumps the Policy Summary Report page
// structure (controls, grid, export buttons) so report selectors can be written
// against the real DOM. Read-only: it never runs a search or a download.
//
//   node scripts/inspect-hiib-policy-summary.js
//   HIIB_CAPTCHA_MODE=manual node scripts/inspect-hiib-policy-summary.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { loginToHiibPortal } from '../src/auth/hiib-login.js';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';
import { sleep } from '../src/utils/sleep.js';

const OUTPUT_DIR = path.join(config.rootDir, 'temp');

function describeFrame() {
  const pick = element => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || undefined,
      id: element.id || undefined,
      name: element.getAttribute('name') || undefined,
      className: (element.getAttribute('class') || '').slice(0, 160) || undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      value: element.tagName.toLowerCase() === 'input' ? (element.value || '').slice(0, 40) : undefined,
      text: (element.innerText || element.textContent || '').trim().slice(0, 80) || undefined,
      title: element.getAttribute('title') || undefined,
      onclick: (element.getAttribute('onclick') || '').slice(0, 160) || undefined,
      href: (element.getAttribute('href') || '').slice(0, 160) || undefined,
      visible: rect.width > 0 && rect.height > 0
    };
  };

  const controls = Array.from(
    document.querySelectorAll('input, select, textarea, button, a[onclick], a.btn, [role="button"]')
  ).map(pick);

  const selects = Array.from(document.querySelectorAll('select')).map(select => ({
    id: select.id || undefined,
    name: select.getAttribute('name') || undefined,
    optionCount: select.options.length,
    options: Array.from(select.options).slice(0, 25).map(option => ({
      value: option.value,
      text: (option.text || '').trim().slice(0, 60)
    }))
  }));

  const tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map(table => ({
    id: table.id || undefined,
    className: (table.getAttribute('class') || '').slice(0, 120) || undefined,
    rowCount: table.rows.length,
    headerCells: Array.from(table.querySelectorAll('thead th, tr:first-child th, tr:first-child td'))
      .slice(0, 40)
      .map(cell => (cell.innerText || '').trim().slice(0, 60))
      .filter(Boolean)
  }));

  const gridHosts = Array.from(
    document.querySelectorAll('[id*="grid" i], [class*="grid" i], [id*="Grid"], .k-grid, .dataTables_wrapper')
  ).slice(0, 20).map(element => ({
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    className: (element.getAttribute('class') || '').slice(0, 160) || undefined
  }));

  const datepickers = Array.from(
    document.querySelectorAll('input[type="date"], .datepicker, [id*="date" i], [class*="datepicker" i]')
  ).slice(0, 20).map(pick);

  return {
    url: location.href,
    title: document.title,
    hasJQuery: !!(window.jQuery || window.$),
    hasKendo: !!window.kendo,
    hasDataTables: !!(window.jQuery && window.jQuery.fn && window.jQuery.fn.DataTable),
    scripts: Array.from(document.scripts).map(s => s.src).filter(Boolean).slice(0, 40),
    controls,
    selects,
    tables,
    gridHosts,
    datepickers,
    bodyTextPreview: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500)
  };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const session = await loginToHiibPortal();

  try {
    const { page } = session;

    logger.info('Opening HIIB Policy Summary Report page', { url: config.hiibPolicySummaryReportUrl });
    await page.goto(config.hiibPolicySummaryReportUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await sleep(4000);

    const frames = [];
    for (const frame of page.frames()) {
      try {
        const snapshot = await frame.evaluate(describeFrame);
        frames.push({ frameName: frame.name() || '(main)', frameUrl: frame.url(), ...snapshot });
      } catch (error) {
        frames.push({ frameName: frame.name() || '(main)', frameUrl: frame.url(), error: error.message });
      }
    }

    const dumpPath = path.join(OUTPUT_DIR, 'hiib-policy-summary-dom.json');
    await fs.writeFile(dumpPath, JSON.stringify({ capturedAt: new Date().toISOString(), pageUrl: page.url(), frames }, null, 2));

    const htmlPath = path.join(OUTPUT_DIR, 'hiib-policy-summary.html');
    await fs.writeFile(htmlPath, await page.content());

    const shotPath = path.join(OUTPUT_DIR, 'hiib-policy-summary.png');
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    logger.info('HIIB Policy Summary Report page captured', {
      dumpPath,
      htmlPath,
      shotPath,
      frameCount: frames.length,
      controlCount: frames.reduce((total, frame) => total + (frame.controls?.length ?? 0), 0)
    });
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch(error => {
  logger.error('HIIB Policy Summary Report inspection failed', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});
