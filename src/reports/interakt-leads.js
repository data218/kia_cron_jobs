// Interakt (app.interakt.ai) social-media lead capture.
//
// Runs every 10 minutes 09:00-18:30, so it must be cheap and must NOT re-login each time:
// the storage state is saved after every successful run and reused on the next one. Login
// sometimes challenges with an OTP delivered over WhatsApp, which no automation can read —
// that path drops to a manual prompt on stdin and is only reachable in a visible browser.
//
// Scrape rule: the inbox is newest-first, so walk the conversation cards from the top and
// stop at the FIRST card whose age is a day or older. Only "x mins"/"x hrs" cards are new
// since the last run; anything in days was captured by an earlier run.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';

import { config } from '../config.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

const LIST = '[data-testid="inbox-search-results-conversation-list"]';
const CARD = '[data-testid="inbox-search-results-conversation-list-card"]';
const CARD_NAME = '[data-testid="pure-conversation-card-v2-label-10"]';
const CARD_AGE = '[data-testid="pure-conversation-card-v2-label"]';

/**
 * True when the card's age is within the last N days (default 7).
 *
 * Accepts "just now", minutes, hours and "N days" up to the cutoff; rejects anything in
 * weeks/months/years, and days beyond the window.
 */
export function isFreshAge(text, maxDays = config.interaktLeadMaxAgeDays) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value) return false;

  // Word boundaries deliberately avoided here: earlier edits kept turning them into
  // literal backspace characters, which silently made every card fail the test.
  if (/week|month|year|yr/.test(value)) return false;

  const days = value.match(/([0-9]+) *day/);
  if (days) return Number.parseInt(days[1], 10) <= maxDays;

  return /min|hr|hour|now|just/.test(value);
}

/**
 * Closes the "BEWARE OF FAKE INTERAKT WEBSITES" interstitial that Interakt shows on the
 * login page some of the time. It overlays the form, so this must run BEFORE the sign-in
 * check — otherwise the password field is judged not-visible and the login is skipped.
 *
 * Keyed on data-testid, not the styled-components class names, which change per build.
 * Silent no-op when the popup is absent, which is the common case.
 */
async function dismissLoginWarningPopup(page) {
  const closeButton = page.locator('[data-testid="login-page-warning-popup-close-button"]').first();
  if (!(await closeButton.isVisible({ timeout: 5000 }).catch(() => false))) return false;

  logger.info('Closing Interakt fake-website warning popup');
  await closeButton.click().catch(async () => {
    await closeButton.click({ force: true }).catch(() => {});
  });
  await closeButton.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  await sleep(800);
  return true;
}

async function promptForOtp(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(promptText)).trim();
  } finally {
    rl.close();
  }
}

export async function loginToInterakt({ headless = false } = {}) {
  const statePath = config.interaktSessionStatePath;
  const hasState = await fs.access(statePath).then(() => true).catch(() => false);

  const browser = await chromium.launch({
    headless,
    slowMo: config.slowMoMs,
    args: headless ? [] : ['--start-maximized']
  });
  const context = await browser.newContext({
    viewport: headless ? undefined : null,
    storageState: hasState ? statePath : undefined
  });
  context.setDefaultTimeout(config.playwrightActionTimeoutMs);
  const page = await context.newPage();

  const save = async () => {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
    logger.info('Interakt session state saved', { path: statePath });
  };

  await page.goto(config.interaktLoginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await dismissLoginWarningPopup(page);

  // Decide by looking for the LOGIN FORM, not for the inbox.
  //
  // The inbox list can take well over 15s to render on a reused session, and treating
  // "inbox not painted yet" as "logged out" sent the run down the sign-in path, where it
  // then timed out filling an email box that was never on the page.
  const emailBox = page.locator('input#email, [data-testid="login-page-email-input-textbox"] input').first();
  const onLoginForm = await emailBox.isVisible({ timeout: 10000 }).catch(() => false);
  logger.info('Interakt entry state', { url: page.url(), onLoginForm });

  if (!onLoginForm) {
    logger.info('Interakt session reused; waiting for the inbox to render');
    await page.locator(LIST).first().waitFor({ state: 'visible', timeout: 120000 });
    logger.info('Interakt inbox ready');
    await save();
    return { browser, context, page, saveState: save };
  }

  if (headless) {
    await browser.close().catch(() => {});
    throw new Error(
      'Interakt needs a fresh login but the browser is headless. Run once with a visible ' +
      'browser (no --headless) so the WhatsApp OTP can be entered, then the saved session ' +
      'carries the 10-minute cron.'
    );
  }

  logger.info('Signing in to Interakt', { userId: config.interaktUserId });
  // Re-check: the popup can render late, after the form is already painted.
  await dismissLoginWarningPopup(page);
  // The wrapper div ALSO carries id="email"/"password", so scope to the <input> explicitly.
  await emailBox.fill(config.interaktUserId);
  await page.locator('input#password, [data-testid="login-page-password-input-textbox"] input')
    .first().fill(config.interaktPassword);
  // Two buttons on this page say "Sign in": the Google SSO one appears FIRST in the DOM.
  // A comma-union locator resolves in DOM order, not selector order, so `.first()` on a
  // union would click Google. Match the testid alone, and fall back to an EXACT-text match
  // ("Sign in with Google" fails :text-is) rather than a substring.
  let signInButton = page.locator('[data-testid="login-page-signin-button"]').first();
  if (!(await signInButton.count().catch(() => 0))) {
    signInButton = page.locator('button:text-is("Sign in")').first();
  }

  await signInButton.waitFor({ state: 'visible', timeout: 30000 });
  await signInButton.click().catch(async () => {
    await signInButton.click({ force: true });
  });
  logger.info('Interakt sign-in submitted');
  await sleep(5000);

  // OTP arrives on WhatsApp, so a human has to read it. Wait on stdin rather than guessing.
  const otpBox = page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[placeholder*="OTP" i]').first();
  if (await otpBox.isVisible({ timeout: 10000 }).catch(() => false)) {
    logger.warn('Interakt is asking for a WhatsApp OTP — enter it in the terminal');
    const otp = await promptForOtp('Enter the Interakt WhatsApp OTP, then press Enter: ');
    if (!otp) throw new Error('No OTP entered; aborting Interakt login');

    const boxes = page.locator('input[autocomplete="one-time-code"], input[name*="otp" i]');
    const count = await boxes.count().catch(() => 1);
    if (count > 1) {
      // Split across one input per digit.
      for (let i = 0; i < Math.min(count, otp.length); i += 1) {
        await boxes.nth(i).fill(otp[i]);
      }
    } else {
      await otpBox.fill(otp);
    }
    // Same trap as above: never substring-match "Sign in" here.
    const verifyButton = page.locator([
      '[data-testid="login-page-signin-button"]',
      'button:text-is("Verify")',
      'button:text-is("Submit")',
      'button:text-is("Sign in")'
    ].join(',')).first();
    await verifyButton.click({ force: true }).catch(() => {});
    await sleep(5000);
  }

  await page.locator(LIST).first().waitFor({ state: 'visible', timeout: 90000 });
  logger.info('Interakt login complete');
  await save();
  return { browser, context, page, saveState: save };
}

/**
 * Reads the open "Details" side panel as label/value pairs.
 *
 * Interakt ships styled-components class names (sc-eqUAAy kHcPmz…) that change on every
 * front-end build, so this walks the DOM structurally from the "Details" heading instead of
 * binding to any generated class.
 */
/**
 * Reads the open conversation: the Contact Details sidebar plus the whole chat transcript.
 *
 * Replaces the old "View Details" popup scrape — that panel had to be opened per lead and
 * navigated away from. Everything needed is already on screen in the three-column layout.
 */
async function readLeadDetails(page) {
  return page.evaluate(() => {
    const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const out = {};

    // --- header: contact name + assignment ---
    out['Assigned To'] = text(document.querySelector('[data-testid="assign-chat-dropdown"]'));

    // --- Contact Details sidebar: "Label:" followed by its value ---
    const labels = ['Contact', 'Email', 'WhatsApp Opted', 'Phone', 'Country'];
    for (const node of Array.from(document.querySelectorAll('p, div, span'))) {
      const raw = text(node);
      const hit = labels.find(l => raw === `${l}:` || raw === l);
      if (!hit || out[hit] !== undefined) continue;
      const next = node.nextElementSibling ?? node.parentElement?.nextElementSibling;
      const value = text(next);
      if (value && value.length < 200) out[hit] = value === '-' ? '' : value;
    }

    // --- tags ---
    const tagBlock = Array.from(document.querySelectorAll('p')).find(p => text(p) === 'Tags');
    if (tagBlock) {
      const container = tagBlock.parentElement?.parentElement;
      const tags = Array.from(container?.querySelectorAll('p') ?? [])
        .map(text).filter(t => t && t !== 'Tags' && t !== 'Edit');
      out['Tags'] = tags.join(', ');
    }

    // --- notes ---
    const noteBlock = Array.from(document.querySelectorAll('p')).find(p => text(p) === 'Notes');
    if (noteBlock) {
      const container = noteBlock.parentElement?.parentElement;
      const notes = Array.from(container?.querySelectorAll('p') ?? [])
        .map(text)
        .filter(t => t && t !== 'Notes' && t !== 'ADD' && !/^\d+\/400$/.test(t));
      out['Notes'] = notes.join(' | ');
    }

    // --- chat transcript, oldest first, with direction and timestamp ---
    const messages = [];
    for (const card of Array.from(document.querySelectorAll('[data-testid="inbox-chat-section-message-card"]'))) {
      const stamp = card.querySelector('[data-testid="inbox-chat-section-message-sent-time"]');
      const time = text(stamp);
      const clone = card.cloneNode(true);
      clone.querySelectorAll('[data-testid="inbox-chat-section-message-sent-time"]').forEach(n => n.remove());
      const body = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!body) continue;
      // Outgoing bubbles sit in a right-aligned wrapper; incoming ones do not.
      const outgoing = Boolean(card.closest('.justify-content-end, .kszSQp'));
      messages.push({ time, body, direction: outgoing ? 'out' : 'in' });
    }

    out['Message Count'] = String(messages.length);
    out['First Message'] = messages.length ? messages[0].body.slice(0, 500) : '';
    out['Last Message'] = messages.length ? messages[messages.length - 1].body.slice(0, 500) : '';
    out['Chat Transcript'] = messages
      .map(m => `[${m.direction}${m.time ? ' ' + m.time : ''}] ${m.body}`)
      .join(String.fromCharCode(10))
      .slice(0, 20000);

    // --- ad / campaign source link if the conversation started from an ad ---
    const adLink = document.querySelector('[data-testid="inbox-chat-section-message-card-link"]');
    out['Ad Url'] = adLink?.getAttribute('href') ?? '';

    return out;
  });
}

async function collapseLeftMenu(page) {
  const expanded = page.locator('[data-testid="quick_links_expanded_left_menu.inbox"]').first();
  const isOpen = async () => expanded.isVisible({ timeout: 1000 }).catch(() => false);
  if (!(await isOpen())) return true;

  // page.viewportSize() is SYNCHRONOUS and returns null when the context was created with
  // viewport: null (our maximized window), so fall back to the real window size.
  const box = page.viewportSize() ?? await page.evaluate(
    () => ({ width: window.innerWidth, height: window.innerHeight })
  ).catch(() => ({ width: 1280, height: 800 }));
  // Far-right edge, vertically centred: outside the sidebar, and clear of the conversation
  // cards on the left — clicking one of those would open a lead instead of closing the rail.
  const safeX = Math.max(box.width - 12, 0);
  const safeY = Math.floor(box.height / 2);

  for (const how of ['move-away', 'click-outside', 'escape']) {
    if (!(await isOpen())) return true;

    if (how === 'move-away') await page.mouse.move(safeX, safeY).catch(() => {});
    if (how === 'click-outside') {
      // The rail is a hover sidebar: only a click outside it dismisses it reliably.
      await page.mouse.move(safeX, safeY).catch(() => {});
      await page.mouse.click(safeX, safeY).catch(() => {});
    }
    if (how === 'escape') await page.keyboard.press('Escape').catch(() => {});

    await expanded.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
    await sleep(500);
  }

  const stillOpen = await isOpen();
  if (stillOpen) logger.warn('Left sidebar stayed expanded; card clicks may be blocked');
  return !stillOpen;
}

async function returnToInbox(page) {
  const collapsed = page.locator('[data-testid="quick_links_collapsed_left_menu.inbox"]').first();
  const expanded = page.locator('[data-testid="quick_links_expanded_left_menu.inbox"]').first();

  if (await collapsed.isVisible({ timeout: 5000 }).catch(() => false)) {
    await collapsed.hover().catch(() => {});
    await sleep(700);
    if (await expanded.isVisible({ timeout: 4000 }).catch(() => false)) {
      await expanded.click().catch(() => {});
    } else {
      await collapsed.click().catch(() => {});
    }
  } else {
    await page.locator('a[href="/inbox"]').first().click({ timeout: 5000 }).catch(() => {});
  }

  const back = await page.locator(LIST).first()
    .waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);

  if (!back) {
    logger.warn('Left menu did not return to the inbox; navigating directly');
    await page.goto(config.interaktInboxUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.locator(LIST).first().waitFor({ state: 'visible', timeout: 60000 });
  }

  await collapseLeftMenu(page);
  await sleep(1500);
  return true;
}

/**
 * Forces the inbox one-click filter to "All Chats".
 *
 * The saved session restores whatever filter was last used (the URL carries
 * chatStatus:"Open"), so by default any lead whose chat was closed is invisible to the
 * sweep. Idempotent: if All Chats is already selected it closes the dropdown without
 * touching Apply.
 */
async function ensureAllChatsFilter(page) {
  const trigger = page.locator('[data-testid="one-click-filter-label-1"]').first();
  if (!(await trigger.isVisible({ timeout: 10000 }).catch(() => false))) {
    logger.warn('Chat-status filter control not found; continuing with the current filter');
    return false;
  }

  logger.info('Chat-status filter currently shows', {
    current: (await trigger.textContent().catch(() => '') ?? '').trim()
  });

  await trigger.click();
  const dropdown = page.locator('[data-testid="one-click-filter-dropdown"]').first();
  await dropdown.waitFor({ state: 'visible', timeout: 15000 });

  const allChatsRow = dropdown
    .locator('[data-testid="one-click-filter-label-4"]:text-is("All Chats")')
    .first()
    .locator('xpath=..');
  const radio = allChatsRow.locator('[data-testid="radioV2"]').first();
  const selected = (await radio.getAttribute('data-value').catch(() => null)) === 'true';

  if (selected) {
    logger.info('All Chats already selected; leaving the filter as is');
    await closeFilterDropdown(page, dropdown, trigger);
    return false;
  }

  logger.info('Selecting All Chats and applying');
  await allChatsRow.click();
  await sleep(400);
  await dropdown.locator('[data-testid="one-click-filter-button"]').first().click();
  await dropdown.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await closeFilterDropdown(page, dropdown, trigger);
  await sleep(4000);
  await page.locator(LIST).first().waitFor({ state: 'visible', timeout: 60000 });
  logger.info('All Chats filter applied');
  return true;
}

/**
 * Closes the filter dropdown and proves it closed — left open it overlays the conversation
 * list and swallows the click on the first card.
 */
async function closeFilterDropdown(page, dropdown, trigger) {
  const isOpen = async () => dropdown.isVisible({ timeout: 1000 }).catch(() => false);

  for (const how of ['escape', 'trigger', 'outside']) {
    if (!(await isOpen())) return true;
    if (how === 'escape') await page.keyboard.press('Escape').catch(() => {});
    if (how === 'trigger') await trigger.click({ force: true }).catch(() => {});
    if (how === 'outside') await page.mouse.click(8, 8).catch(() => {});
    await dropdown.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await sleep(400);
  }

  const stillOpen = await isOpen();
  if (stillOpen) logger.warn('Filter dropdown would not close; card clicks may be blocked');
  return !stillOpen;
}

export async function scrapeInteraktLeads(page, { maxLeads = 100 } = {}) {
  await page.locator(LIST).first().waitFor({ state: 'visible', timeout: 60000 });
  await ensureAllChatsFilter(page).catch(error => {
    logger.warn('Could not switch to All Chats; continuing anyway', { error: error.message });
  });

  const leads = [];
  const processed = new Set();
  let stopReason = 'max_leads';
  let staleStreak = 0;
  const STALE_STREAK_LIMIT = 25;
  let emptyScrolls = 0;

  // The list is virtualised: only the cards in view are mounted, and every click re-renders
  // it. So re-read the rendered window each pass, process any fresh card not seen before,
  // then scroll to mount the next batch — rather than indexing off a snapshot.
  while (leads.length < maxLeads && emptyScrolls < 3) {
    const cards = page.locator(CARD);
    const rendered = await cards.count().catch(() => 0);
    let didWork = false;

    for (let index = 0; index < rendered && leads.length < maxLeads; index += 1) {
      const card = cards.nth(index);

      let age = (await card.locator(CARD_AGE).first().textContent().catch(() => '') ?? '').trim();
      const name = (await card.locator(CARD_NAME).first().textContent().catch(() => '') ?? '').trim();

      if (!age) {
        const cardText = (await card.textContent().catch(() => '') ?? '').replace(/\s+/g, ' ');
        const match = cardText.match(
          /(just now|now|\d+\s*(?:mins?|minutes?|hrs?|hours?|days?|weeks?|months?|years?))/i
        );
        age = match ? match[1] : '';
      }

      const key = `${name}::${age}`;
      if (processed.has(key)) continue;
      processed.add(key);
      didWork = true;

      logger.info('Card age', { index, name, age: age || '(none)', fresh: isFreshAge(age) });

      if (!age) {
        logger.warn('Could not read lead age; skipping card', { index, name });
        continue;
      }

      if (!isFreshAge(age)) {
        staleStreak += 1;
        if (staleStreak >= STALE_STREAK_LIMIT) {
          logger.info('Hit a long run of old leads; ending sweep', { index, staleStreak });
          stopReason = 'aged_out';
          return { leads, stopReason };
        }
        continue;
      }
      staleStreak = 0;

      logger.info('Opening lead', { index, name, age });
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.click({ timeout: 20000 }).catch(async () => {
        await card.click({ force: true }).catch(() => {});
      });
      // Let the chat pane and Contact Details sidebar paint for the newly selected chat.
      await sleep(3000);
      await page.locator('[data-testid="inbox-chat-section-message-card"]').first()
        .waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

      const details = await readLeadDetails(page);
      if (!details || !Object.keys(details).length) {
        logger.warn('Could not read conversation; skipping', { name });
        continue;
      }

      const lead = { 'Conversation Name': name, 'Lead Age': age, ...details };
      leads.push(lead);

      const nonEmpty = Object.entries(lead).filter(([, v]) => String(v ?? '').trim() !== '');
      logger.info('Captured lead', {
        name,
        age,
        messageCount: details['Message Count'],
        nonEmptyCount: nonEmpty.length,
        contact: details['Contact'] ?? '',
        total: leads.length
      });
      // The three-column layout keeps the list on screen, so the next card is clicked
      // directly — no navigating back to /inbox and no sidebar to collapse.
    }

    // Scroll the virtualised list to mount the next batch.
    const before = processed.size;
    await page.locator(LIST).first().evaluate(node => {
      const scroller = node.closest('[class*="ibZZdx"]') ?? node.parentElement ?? node;
      scroller.scrollTop = scroller.scrollHeight;
    }).catch(() => {});
    await page.mouse.wheel(0, 1200).catch(() => {});
    await sleep(2500);

    emptyScrolls = (!didWork && processed.size === before) ? emptyScrolls + 1 : 0;
    if (emptyScrolls >= 3) stopReason = 'end_of_list';
  }

  logger.info('Sweep finished', { scanned: processed.size, captured: leads.length, stopReason });
  return { leads, stopReason };
}

export async function saveInteraktLeads(leads) {
  if (!leads.length) {
    logger.info('No new Interakt leads to save');
    return { rowCount: 0 };
  }

  // Union of keys: Interakt exposes a different custom-field set per lead.
  const headers = [];
  const seen = new Set();
  for (const lead of leads) {
    for (const key of Object.keys(lead)) {
      if (!seen.has(key)) { seen.add(key); headers.push(key); }
    }
  }

  // relational-store reads row[column.header], so rows must be OBJECTS keyed by header —
  // passing header-aligned ARRAYS made every lookup undefined, which wrote an all-NULL row
  // and made every lead hash identically (3 leads collapsed to 1 "duplicate").
  const rows = leads.map(lead => {
    const row = {};
    for (const header of headers) row[header] = lead[header] ?? '';
    return row;
  });

  const populated = rows.filter(row => Object.values(row).some(v => String(v ?? '').trim() !== '')).length;
  logger.info('Prepared lead rows', { headerCount: headers.length, rowCount: rows.length, rowsWithData: populated });
  if (!populated) {
    logger.warn('Every lead row is blank; refusing to write empty rows', { headers: headers.slice(0, 12) });
    return { rowCount: 0, skipped: 'all_rows_blank' };
  }

  const dbResult = await saveReportSheetToSupabase({
    brand: 'interakt',
    sheetName: config.interaktLeadsSheetName,
    headers,
    rows
  });

  logger.info('Interakt leads saved', {
    sheetName: config.interaktLeadsSheetName,
    rowCount: rows.length,
    addedRowCount: dbResult?.addedRowCount,
    duplicateRowCount: dbResult?.duplicateRowCount
  });

  return { rowCount: rows.length, dbResult };
}

export async function runInteraktLeadCapture({ headless = false, maxLeads = 100 } = {}) {
  const session = await loginToInterakt({ headless });
  try {
    const { leads, stopReason } = await scrapeInteraktLeads(session.page, { maxLeads });
    const saved = await saveInteraktLeads(leads);
    await session.saveState().catch(() => {});
    return { leadCount: leads.length, stopReason, ...saved };
  } finally {
    await session.browser.close().catch(() => {});
  }
}
