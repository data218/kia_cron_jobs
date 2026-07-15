import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { sleep } from '../utils/sleep.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const LOGIN_URL = 'https://www.kiasafety.com/VISOF/Login.aspx';
const SCREENSHOT_PATH = path.resolve(config.rootDir, 'logs/screenshots/policy-summary-page.png');
const HTML_PATH = path.resolve(config.rootDir, 'logs/policy-summary-html.txt');
const STATE_PATH = path.resolve(config.rootDir, 'storage/kia-safety-state.json');

async function main() {
  await fs.mkdir(path.dirname(SCREENSHOT_PATH), { recursive: true });
  await fs.mkdir(path.dirname(HTML_PATH), { recursive: true });
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMoMs
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 }
  });
  context.setDefaultTimeout(60000);
  const page = await context.newPage();

  try {
    logger.info('Opening Kia Safety login page', { url: LOGIN_URL });
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);

    const usernameInput = page.locator('#txtUserName');
    await usernameInput.waitFor({ state: 'visible', timeout: 15000 });
    await usernameInput.fill('JK40202');
    await sleep(500);

    const passwordInput = page.locator('#txtPassword');
    await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
    await passwordInput.fill('Abhi@123');
    await sleep(500);

    const loginButton = page.locator('#btnLogin');
    await loginButton.waitFor({ state: 'visible', timeout: 10000 });
    await loginButton.click();
    await sleep(3000);
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    logger.info('Login completed', { url: page.url() });

    await context.storageState({ path: STATE_PATH });
    logger.info('Session saved after login');

    logger.info('Looking for Report tab');
    const reportTab = page.locator('a.dropdown-toggle:has-text("Report")');
    await reportTab.waitFor({ state: 'visible', timeout: 15000 });
    await reportTab.click();
    await sleep(1500);

    const policySummary = page.locator('a:has-text("Policy Summary")');
    await policySummary.waitFor({ state: 'visible', timeout: 15000 });
    await policySummary.click();
    await sleep(3000);
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    logger.info('On Policy Summary page', { url: page.url() });

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    logger.info('Screenshot saved', { path: SCREENSHOT_PATH });

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    await fs.writeFile(HTML_PATH, html, 'utf-8');
    logger.info('HTML dumped', { path: HTML_PATH });

    await context.storageState({ path: STATE_PATH });
    logger.info('Final session state saved', { path: STATE_PATH });

    await page.evaluate(async () => {
      const fields = [];
      document.querySelectorAll('input[type="text"], input[type="date"], input[type="submit"], input[type="button"], a, button').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          fields.push({
            tag: el.tagName,
            id: el.id,
            name: el.name,
            type: el.type || el.getAttribute('type'),
            value: el.value || el.textContent?.trim()?.slice(0, 80),
            className: el.className?.slice(0, 60),
            href: el.getAttribute('href')?.slice(0, 120),
            onclick: el.getAttribute('onclick')?.slice(0, 120),
            visible: rect.width > 0 && rect.height > 0,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
          });
        }
      });
      return fields;
    });

    const pageInfo = await page.evaluate(() => {
      const inputs = [];
      document.querySelectorAll('input, select, textarea, button, a[href], img[alt*="calendar" i], img[src*="cal" i]').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const data = {
            tag: el.tagName,
            id: el.id || '',
            name: el.name || '',
            type: el.type || el.getAttribute('type') || '',
            value: el.value !== undefined ? el.value.slice(0, 60) : (el.textContent || '').trim().slice(0, 80),
            className: (el.className || '').slice(0, 60),
          };
          if (el.tagName === 'A') {
            data.href = (el.getAttribute('href') || '').slice(0, 150);
            data.onclick = (el.getAttribute('onclick') || '').slice(0, 150);
          }
          if (el.tagName === 'IMG') {
            data.src = (el.getAttribute('src') || '').slice(0, 150);
            data.alt = (el.getAttribute('alt') || '').slice(0, 60);
          }
          inputs.push(data);
        }
      });
      return inputs;
    });

    console.log('\n========== PAGE STRUCTURE SUMMARY ==========');
    console.log('URL:', page.url());
    console.log('Title:', await page.title());

    console.log('\n--- Date Input Fields ---');
    const dateInputs = pageInfo.filter(i =>
      i.id && (i.id.includes('Date') || i.id.includes('date') || i.id.includes('From') || i.id.includes('To'))
    );
    dateInputs.forEach(i => console.log(`  ID: ${i.id}, Name: ${i.name}, Tag: ${i.tag}, Value: "${i.value}"`));

    console.log('\n--- Calendar Icons ---');
    const calIcons = pageInfo.filter(i =>
      (i.tag === 'IMG' && (i.alt?.toLowerCase().includes('cal') || i.src?.toLowerCase().includes('cal'))) ||
      (i.id && (i.id.includes('cal') || i.id.includes('Cal')))
    );
    if (calIcons.length) {
      calIcons.forEach(i => console.log(`  ID: ${i.id}, Src: ${i.src}, Alt: ${i.alt}`));
    } else {
      console.log('  No calendar icons found near date fields');
    }

    console.log('\n--- Buttons ---');
    const buttons = pageInfo.filter(i =>
      (i.tag === 'INPUT' && (i.type === 'submit' || i.type === 'button')) ||
      i.tag === 'BUTTON' ||
      (i.tag === 'A' && (i.value?.toLowerCase().includes('go') || i.value?.toLowerCase().includes('search') || i.value?.toLowerCase().includes('export') || i.value?.toLowerCase().includes('csv') || i.value?.toLowerCase().includes('excel')))
    );
    buttons.forEach(i => {
      console.log(`  ID: ${i.id}, Tag: ${i.tag}, Type: ${i.type}, Value/Text: "${i.value}"${i.href ? ', Href: ' + i.href : ''}${i.onclick ? ', OnClick: ' + i.onclick : ''}`);
    });

    console.log('\n--- Export Links ---');
    const exports = pageInfo.filter(i =>
      i.value?.toLowerCase().includes('csv') ||
      i.value?.toLowerCase().includes('excel') ||
      i.value?.toLowerCase().includes('export') ||
      i.href?.toLowerCase().includes('csv') ||
      i.href?.toLowerCase().includes('excel') ||
      i.href?.toLowerCase().includes('export')
    );
    exports.forEach(i => console.log(`  ID: ${i.id}, Tag: ${i.tag}, Text: "${i.value}", Href: ${i.href}, OnClick: ${i.onclick}`));

    console.log('\n--- All Interactive Elements ---');
    pageInfo.forEach(i => console.log(`  [${i.tag}] ID="${i.id}" Name="${i.name}" Type="${i.type}" Value="${i.value}"` + (i.href ? ` HREF="${i.href}"` : '') + (i.onclick ? ` ONCLICK="${i.onclick}"` : '') + (i.src ? ` SRC="${i.src}"` : '') + (i.alt ? ` ALT="${i.alt}"` : '')));

    console.log('\n============================================');
  } catch (error) {
    logger.error('Script failed', { error: error.message });
    const errScreenshot = SCREENSHOT_PATH.replace('.png', '-error.png');
    await page.screenshot({ path: errScreenshot, fullPage: true }).catch(() => {});
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
