import { config } from '../config.js';
import { firstVisible } from '../playwright/browser.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { openDealerChangePage } from './kia-menu.js';

const KIA_HOME_URL = 'https://dms.kiaindia.net/cmm/cmmd/selectHome.dms';

function isHmilDms(homeUrl) {
  return String(homeUrl || '').includes('ndms.hmil.net');
}

function isHmilHomeOrDealerChangeUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return (
    normalized.includes('selecthome.dms') ||
    normalized.includes('selectdealerchangemain.dms')
  );
}

async function openHmilDealerChangePageDirect(page, expectedOrigin) {
  const dealerChangeUrl = `${expectedOrigin}/cmm/cmmh/selectDealerChangeMain.dms`;
  logger.info('Opening HMIL dealer change via direct URL', { dealerChangeUrl });
  await page.goto(dealerChangeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.locator('#chgDlrCd').first().waitFor({ state: 'visible', timeout: 30000 });
}

async function openKiaDealerChangePageDirect(page, expectedOrigin) {
  const dealerChangeUrl = `${expectedOrigin}/cmm/cmmh/selectDealerChangeMain.dms`;
  logger.info('Opening KIA dealer change via direct URL', { dealerChangeUrl });
  await page.goto(dealerChangeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForDmsOverlayIdle(page, { timeout: 30000 });
  await page.locator('#chgDlrCd').first().waitFor({ state: 'visible', timeout: 30000 });
}

async function waitForDmsOverlayIdle(context, { timeout = 30000 } = {}) {
  const loader = context.locator([
    '.tabmenu_ajax_loader:visible',
    '.k-loading-mask:visible',
    '.k-loading-image:visible',
    '.ajax_loader:visible'
  ].join(','));

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const busy = await loader.first().isVisible({ timeout: 100 }).catch(() => false);
    if (!busy) {
      await sleep(250);
      const stillBusy = await loader.first().isVisible({ timeout: 100 }).catch(() => false);
      if (!stillBusy) return;
    }
    await sleep(100);
  }
}

async function readDealerCodeFromChangeField(changeContext) {
  return String(await changeContext.locator('#chgDlrCd').first().inputValue().catch(() => ''))
    .trim()
    .toUpperCase();
}

async function closeStaleDealerSearchPopups(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const windows = page.locator('.k-window:visible').filter({ hasText: 'Dealer Search' });
    const count = await windows.count().catch(() => 0);
    if (!count) break;

    logger.warn('Closing stale Dealer Search popup window', { count, attempt });
    for (let index = count - 1; index >= 0; index -= 1) {
      await windows.nth(index).locator('.k-i-close, .k-window-action, [aria-label="Close"]').first()
        .click({ force: true, timeout: 1000 })
        .catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
}

async function waitForDealerSearchSurface(page, { timeout = 20000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    for (const frame of page.frames()) {
      if (frame.url().toLowerCase().includes('selectdealersearchpopup')) {
        return frame;
      }
    }
    if (page.url().toLowerCase().includes('selectdealersearchpopup')) {
      return page;
    }
    await sleep(100);
  }
  return page;
}

async function resolveDealerSearchContexts(page) {
  const contexts = [];
  const seen = new Set();

  const add = context => {
    const key = contextUrl(context);
    if (!seen.has(key)) {
      seen.add(key);
      contexts.push(context);
    }
  };

  if (contextUrl(page).includes('selectdealersearchpopup')) {
    add(page);
  }

  for (const frame of page.frames()) {
    if (contextUrl(frame).includes('selectdealersearchpopup')) {
      add(frame);
    }
  }

  return contexts.length ? contexts : [page];
}

async function applyDealerSearchFilter(searchContext, dealerCode) {
  const page = typeof searchContext.page === 'function' ? searchContext.page() : searchContext;
  const contexts = searchContext === page ? await resolveDealerSearchContexts(page) : [searchContext];

  for (const context of contexts) {
    const filterSelectors = [
      '#sDlrCd',
      '#dlrCd',
      '#dealerCode',
      '#txtDealerCode',
      '#txtSearch',
      'input[name="dlrCd"]',
      'input[name="sDlrCd"]',
      'input[name="dealerCode"]'
    ];

    for (const selector of filterSelectors) {
      const input = context.locator(selector).first();
      if (!await input.isVisible({ timeout: 500 }).catch(() => false)) continue;

      logger.info('Filtering Dealer Search popup', { selector, dealerCode });
      await input.click({ timeout: 2000 }).catch(() => {});
      await input.fill('');
      await input.fill(dealerCode);
      const searchButton = await firstVisible(context, [
        '#btnSearch',
        '#btnDealerSearch',
        '#btnDealerSearchPopup',
        'button:has-text("Search")',
        'a:has-text("Search")',
        'input[type="button"][value="Search"]',
        'input[type="submit"][value="Search"]'
      ], 5000).catch(() => null);

      if (searchButton) {
        await searchButton.click({ force: true });
      } else {
        await input.press('Enter').catch(() => {});
      }

      await waitForDmsOverlayIdle(context, { timeout: 20000 });
      return true;
    }
  }

  logger.warn('Dealer Search popup filter field not found; grid may already be loaded', { dealerCode });
  return false;
}

async function refreshDealerSearchGrid(searchContext) {
  const page = typeof searchContext.page === 'function' ? searchContext.page() : searchContext;
  const contexts = searchContext === page ? await resolveDealerSearchContexts(page) : [searchContext];

  for (const context of contexts) {
    const searchButton = await firstVisible(context, [
      '#btnSearch',
      '#btnDealerSearch',
      '#btnDealerSearchPopup',
      'button:has-text("Search")',
      'a:has-text("Search")',
      'input[type="button"][value="Search"]'
    ], 2000).catch(() => null);

    if (searchButton) {
      logger.info('Refreshing Dealer Search popup grid');
      await searchButton.click({ force: true });
      await waitForDmsOverlayIdle(context, { timeout: 20000 });
      return true;
    }
  }

  return false;
}

function dealerRowSelectors(dealerCode) {
  return [
    `tr:has(td:text-is("${dealerCode}"))`,
    `tr:has-text("${dealerCode}")`,
    `.k-grid-content tr:has-text("${dealerCode}")`,
    `li:has-text("${dealerCode}")`
  ];
}

async function openDealerSearchPopup(page, clickSearch, clickContext) {
  await closeStaleDealerSearchPopups(page);
  await dismissDealerSearchBlockers(page);
  await dismissDealerSearchBlockers(clickContext);
  await waitForDmsOverlayIdle(page, { timeout: 30000 });
  await waitForDmsOverlayIdle(clickContext, { timeout: 30000 });

  const popupPromise = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
  let opened = false;

  try {
    await clickSearch.click({ timeout: 15000 });
    opened = true;
  } catch (error) {
    logger.warn('Dealer search link click failed; trying JS popup opener', {
      error: error.message
    });
  }

  if (!opened) {
    await clickContext.evaluate(() => {
      if (typeof globalThis.fnDealerSearchPopupWin === 'function') {
        globalThis.fnDealerSearchPopupWin();
        return true;
      }
      return false;
    }).catch(() => false);
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    logger.info('Dealer search opened in popup window', { url: popup.url() });
    return popup;
  }

  logger.info('Dealer search did not open a new window; checking in-page popup/frame');
  await sleep(1500);
  return waitForDealerSearchSurface(page, { timeout: 20000 });
}

async function getDealerPopup(page, clickSearch, clickContext = page, dealerCode) {
  return openDealerSearchPopup(page, clickSearch, clickContext);
}

function contextUrl(context) {
  return String(typeof context.url === 'function' ? context.url() : context.url || '').toLowerCase();
}

async function searchDealerInPopupOnce(popup, dealerCode) {
  const page = typeof popup.page === 'function' ? popup.page() : popup;
  await sleep(1500);

  const searchContexts = contextUrl(popup).includes('selectdealersearchpopup')
    ? [popup]
    : await resolveDealerSearchContexts(page);

  for (const searchSurface of searchContexts) {
    await waitForDmsOverlayIdle(searchSurface, { timeout: 20000 });
  }

  const trySelectRow = async ({ timeout = 20000, label = 'primary' } = {}) => {
    let lastError;
    for (const searchSurface of [...searchContexts, page]) {
      try {
        const context = await findDealerPopupContext(searchSurface, dealerCode, { timeout });
        await selectDealerSearchResult(context, dealerCode);
        logger.info('Dealer row selected from popup', { dealerCode, label });
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Dealer Search popup opened but dealer row ${dealerCode} was not visible`);
  };

  try {
    await trySelectRow({ timeout: 4000, label: 'fast-path' });
    return;
  } catch {
    logger.info('Dealer row not immediately visible; applying popup search filter', { dealerCode });
  }

  for (const searchSurface of searchContexts) {
    await applyDealerSearchFilter(searchSurface, dealerCode);
  }
  await applyDealerSearchFilter(page, dealerCode).catch(() => false);

  try {
    await trySelectRow({ timeout: 15000, label: 'after-filter' });
    return;
  } catch {
    logger.warn('Dealer row still not visible after filter; refreshing popup grid', { dealerCode });
  }

  for (const searchSurface of searchContexts) {
    await refreshDealerSearchGrid(searchSurface);
  }
  await refreshDealerSearchGrid(page).catch(() => false);

  await trySelectRow({ timeout: 20000, label: 'after-refresh' });
}

async function searchDealerInPopup(popup, dealerCode) {
  await searchDealerInPopupOnce(popup, dealerCode);
}

async function findDealerPopupContext(popup, dealerCode, { timeout = 20000 } = {}) {
  const selector = dealerRowSelectors(dealerCode).join(',');

  try {
    return await findContextWithVisibleSelector(popup, selector, {
      timeout,
      label: `Dealer popup row ${dealerCode}`
    });
  } catch {
    throw new Error(`Dealer Search popup opened but dealer row ${dealerCode} was not visible`);
  }
}

async function dismissDealerSearchBlockers(context) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const closeButtons = context.locator([
      '.k-window:visible:not(:has-text("Dealer Search")) .k-window-action',
      '.k-window:visible:not(:has-text("Dealer Search")) .k-i-close',
      '.k-window:visible:not(:has-text("Dealer Search")) [aria-label="Close"]',
      '.k-window:visible:not(:has-text("Dealer Search")) button:has-text("×")',
      '.k-window:visible:not(:has-text("Dealer Search")) .k-window-titlebar button',
      '.k-window:visible:not(:has-text("Dealer Search")) .k-window-titlebar a',
      '.k-animation-container:visible:not(:has-text("Dealer Search")) .k-window-action',
      '.k-animation-container:visible:not(:has-text("Dealer Search")) .k-i-close',
      '.k-animation-container:visible:not(:has-text("Dealer Search")) [aria-label="Close"]',
      '.k-animation-container:visible:not(:has-text("Dealer Search")) button:has-text("×")',
      '.k-window:visible:has-text("Common Message") .k-i-close',
      '.k-window:visible:has-text("Common Message") .k-window-action',
      '.k-window:visible:has-text("Common Message") [aria-label="Close"]',
      '.k-window:visible:has-text("Common Message") .k-window-titlebar button',
      '.k-window:visible:has-text("Common Message") .k-window-titlebar a',
      '.k-animation-container:visible:has-text("Common Message") .k-i-close',
      '.k-animation-container:visible:has-text("Common Message") .k-window-action',
      '.k-animation-container:visible:has-text("Common Message") [aria-label="Close"]',
      '.k-animation-container:visible:has(.notification_msgBox) .k-i-close',
      '.k-animation-container:visible:has(.notification_msgBox) .k-window-action',
      '.k-animation-container:visible:has(.notification_msgBox) [aria-label="Close"]',
      '.k-animation-container:visible .k-tooltip-validation .k-i-close',
      '.k-animation-container:visible .k-notification .k-i-close',
      '.k-animation-container:visible .k-i-close',
      '.k-tooltip-validation:visible .k-i-close',
      '.k-invalid-msg:visible .k-i-close',
      '[class*="tooltip"]:visible .k-i-close'
    ].join(','));

    const count = await closeButtons.count().catch(() => 0);
    if (!count) break;

    logger.warn('Dismissing blocking Dealer Search popup message', { count, attempt });
    for (let index = count - 1; index >= 0; index -= 1) {
      await closeButtons.nth(index).click({ force: true, timeout: 1000 }).catch(() => {});
    }
    await context.keyboard?.press('Escape').catch(() => {});
  }
}

async function selectDealerSearchResult(context, dealerCode) {
  const row = context.locator(dealerRowSelectors(dealerCode).join(',')).first();

  await row.waitFor({ state: 'visible', timeout: 20000 });
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await dismissDealerSearchBlockers(context);

  const checkbox = row.locator('input[type="checkbox"], .k-checkbox').first();
  if (await checkbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    await checkbox.check({ force: true }).catch(async () => {
      await checkbox.click({ force: true });
    });
  } else {
    await row.click({ force: true });
  }

  await dismissDealerSearchBlockers(context);
  const addSelectedButton = await firstVisible(context, [
    '#btnAddSelected',
    '#btnAdd',
    'button:has-text("Add Selected")',
    'a:has-text("Add Selected")',
    'input[type="button"][value="Add Selected"]',
    'button:has-text("Add")',
    'a:has-text("Add")'
  ], 30000);

  await addSelectedButton.click({ force: true });
}

async function waitForDealerCode(changeContext, dealerCode) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < config.dealerChangeTimeoutMs) {
    const value = await changeContext.locator('#chgDlrCd').first().inputValue().catch(() => '');
    if (value.trim().toUpperCase() === dealerCode.toUpperCase()) {
      return;
    }
    await sleep(50);
  }

  throw new Error(`Dealer code ${dealerCode} was not populated on Dealer Change screen`);
}

async function confirmDealerChange(changeContext, dealerCode) {
  const page = typeof changeContext.page === 'function' ? changeContext.page() : changeContext;
  page.once?.('dialog', dialog => dialog.accept().catch(() => {}));

  const changeButton = await firstVisible(changeContext, [
    '#btnDlrChange',
    'button#btnDlrChange',
    'button:has-text("Change")',
    'input[type="button"][value="Change"]'
  ], 30000);

  await changeButton.click();
  await page.waitForLoadState?.('domcontentloaded', { timeout: 5000 }).catch(() => {});

  logger.info('Dealer change submitted', { dealerCode });
}

export async function changeActiveDealerForDms(page, dealerCode, {
  homeUrl = KIA_HOME_URL,
  systemLabel = 'KIA DMS'
} = {}) {
  const normalizedDealerCode = String(dealerCode ?? '').trim().toUpperCase();
  if (!normalizedDealerCode) {
    throw new Error('Dealer code is required for dealer change');
  }

  logger.info(`Changing active ${systemLabel} dealer`, { dealerCode: normalizedDealerCode });

  const currentUrl = page.url();
  const expectedOrigin = new URL(homeUrl).origin;
  const isOnTargetDms = currentUrl.startsWith(`${expectedOrigin}/`);

  if (!isOnTargetDms) {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
      logger.warn(`Could not navigate directly to ${systemLabel} home before dealer change`, {
        dealerCode: normalizedDealerCode,
        error: error.message
      });
    });
  }

  if (isHmilDms(homeUrl)) {
    if (!isHmilHomeOrDealerChangeUrl(currentUrl)) {
      const hmilHomeUrl = `${expectedOrigin}/cmm/cmmd/selectHome.dms`;
      logger.info('Resetting HMIL session to home before dealer change', {
        fromUrl: currentUrl,
        hmilHomeUrl
      });
      await page.goto(hmilHomeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    }

    try {
      await openHmilDealerChangePageDirect(page, expectedOrigin);
    } catch (directError) {
      logger.warn('HMIL direct dealer change URL failed, falling back to menu navigation', {
        dealerCode: normalizedDealerCode,
        error: directError.message
      });
      await openDealerChangePage(page);
    }
  } else {
    try {
      await openKiaDealerChangePageDirect(page, expectedOrigin);
    } catch (directError) {
      logger.warn('KIA direct dealer change URL failed, falling back to menu navigation', {
        dealerCode: normalizedDealerCode,
        error: directError.message
      });
      await openDealerChangePage(page).catch(async error => {
        logger.warn(`Dealer Change navigation failed from current page; retrying from ${systemLabel} home`, {
          dealerCode: normalizedDealerCode,
          currentUrl,
          error: error.message
        });
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await openDealerChangePage(page);
      });
    }
  }

  const changeContext = await findContextWithVisibleSelector(page, '#chgDlrCd', {
    timeout: config.dealerChangeTimeoutMs,
    label: 'Dealer Change field'
  }).catch(async error => {
    if (isHmilDms(homeUrl)) {
      throw error;
    }

    const directDealerChangeUrl = `${expectedOrigin}/cmm/cmmh/selectDealerChangeMain.dms`;
    logger.warn(`Dealer Change field did not load after navigation; opening direct ${systemLabel} Dealer Change URL`, {
      dealerCode: normalizedDealerCode,
      url: directDealerChangeUrl,
      error: error.message
    });

    await page.goto(directDealerChangeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    return findContextWithVisibleSelector(page, '#chgDlrCd', {
      timeout: config.dealerChangeTimeoutMs,
      label: 'Dealer Change field'
    });
  });

  await waitForDmsOverlayIdle(page, { timeout: 30000 });
  await waitForDmsOverlayIdle(changeContext, { timeout: 30000 });

  const currentDealerCode = await readDealerCodeFromChangeField(changeContext);
  if (currentDealerCode === normalizedDealerCode) {
    logger.info(`Active ${systemLabel} dealer already set; skipping dealer change`, {
      dealerCode: normalizedDealerCode
    });
    return;
  }

  if (!currentDealerCode) {
    logger.info('Dealer Change field is empty; proceeding with dealer search popup', {
      dealerCode: normalizedDealerCode
    });
  }

  const searchLink = await firstVisible(changeContext, [
    '.change_search a:has-text("Search")',
    'a[href*="fnDealerSearchPopupWin"]',
    'a:has-text("Search")'
  ], 30000);

  await dismissDealerSearchBlockers(page);
  await dismissDealerSearchBlockers(changeContext);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (attempt > 1 && !isHmilDms(homeUrl)) {
        logger.info('Reloading KIA dealer change page before retry', {
          dealerCode: normalizedDealerCode,
          attempt
        });
        await openKiaDealerChangePageDirect(page, expectedOrigin);
      }

      const retryChangeContext = attempt > 1
        ? await findContextWithVisibleSelector(page, '#chgDlrCd', {
          timeout: config.dealerChangeTimeoutMs,
          label: 'Dealer Change field'
        })
        : changeContext;

      const retryCurrentDealerCode = await readDealerCodeFromChangeField(retryChangeContext);
      if (retryCurrentDealerCode === normalizedDealerCode) {
        logger.info(`Active ${systemLabel} dealer already set after reload; skipping dealer change`, {
          dealerCode: normalizedDealerCode,
          attempt
        });
        lastError = null;
        break;
      }

      const retrySearchLink = attempt > 1
        ? await firstVisible(retryChangeContext, [
          '.change_search a:has-text("Search")',
          'a[href*="fnDealerSearchPopupWin"]',
          'a:has-text("Search")'
        ], 30000)
        : searchLink;

      const popup = await getDealerPopup(page, retrySearchLink, retryChangeContext, normalizedDealerCode);
      await searchDealerInPopupOnce(popup, normalizedDealerCode);

      if (popup !== page && typeof popup.isClosed === 'function' && !popup.isClosed()) {
        await popup.waitForEvent('close', { timeout: 1000 }).catch(() => {});
      }
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      logger.warn('Dealer change search attempt failed; retrying', {
        dealerCode: normalizedDealerCode,
        attempt,
        error: error.message
      });
      await closeStaleDealerSearchPopups(page);
      await dismissDealerSearchBlockers(page);
      await dismissDealerSearchBlockers(changeContext);
      await waitForDmsOverlayIdle(page, { timeout: 15000 });
      await waitForDmsOverlayIdle(changeContext, { timeout: 15000 });
      await sleep(500);
    }
  }

  if (lastError) {
    throw lastError;
  }

  await waitForDealerCode(changeContext, normalizedDealerCode);
  await confirmDealerChange(changeContext, normalizedDealerCode);

  logger.info(`Active ${systemLabel} dealer changed`, { dealerCode: normalizedDealerCode });
}

export async function changeActiveDealer(page, dealerCode) {
  return changeActiveDealerForDms(page, dealerCode, {
    homeUrl: KIA_HOME_URL,
    systemLabel: 'KIA DMS'
  });
}
