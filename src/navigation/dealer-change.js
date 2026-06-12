import { config } from '../config.js';
import { firstVisible } from '../playwright/browser.js';
import { findContextWithVisibleSelector } from '../playwright/frame-resolver.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { openDealerChangePage } from './kia-menu.js';

const KIA_HOME_URL = 'https://dms.kiaindia.net/cmm/cmmd/selectHome.dms';

function dealerRowSelectors(dealerCode) {
  return [
    `tr:has(td:text-is("${dealerCode}"))`,
    `tr:has-text("${dealerCode}")`,
    `.k-grid-content tr:has-text("${dealerCode}")`,
    `li:has-text("${dealerCode}")`
  ];
}

async function getDealerPopup(page, clickSearch, clickContext = page, dealerCode) {
  await dismissDealerSearchBlockers(page);
  await dismissDealerSearchBlockers(clickContext);
  const popupPromise = page.waitForEvent('popup', { timeout: 2000 }).catch(() => null);
  await clickSearch.click({ timeout: 5000 }).catch(async error => {
    logger.warn('Dealer search click blocked; dismissing messages and forcing click', {
      error: error.message
    });
    await dismissDealerSearchBlockers(page);
    await dismissDealerSearchBlockers(clickContext);
    await clickSearch.click({ force: true, timeout: 5000 });
  });

  const inPageDealerSearch = dealerCode
    ? await findDealerPopupContext(page, dealerCode, { timeout: 6000 }).catch(() => null)
    : null;

  if (inPageDealerSearch) {
    logger.info('Dealer search rows opened in current page');
    return page;
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    logger.info('Dealer search opened in popup window', { url: popup.url() });
    return popup;
  }

  logger.info('Dealer search did not open a new window; checking in-page popup/frame');
  return page;
}

async function searchDealerInPopup(popup, dealerCode) {
  const context = await findDealerPopupContext(popup, dealerCode);
  await selectDealerSearchResult(context, dealerCode);
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

  await openDealerChangePage(page).catch(async error => {
    logger.warn(`Dealer Change navigation failed from current page; retrying from ${systemLabel} home`, {
      dealerCode: normalizedDealerCode,
      currentUrl,
      error: error.message
    });
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await openDealerChangePage(page);
  });

  const changeContext = await findContextWithVisibleSelector(page, '#chgDlrCd', {
    timeout: 7000,
    label: 'Dealer Change field'
  }).catch(async error => {
    const directDealerChangeUrl = `${expectedOrigin}/cmm/cmmh/selectDealerChangeMain.dms`;
    logger.warn(`Dealer Change field did not load after menu click; opening direct ${systemLabel} Dealer Change URL`, {
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

  const searchLink = await firstVisible(changeContext, [
    '.change_search a:has-text("Search")',
    'a[href*="fnDealerSearchPopupWin"]',
    'a:has-text("Search")'
  ], 30000);

  await dismissDealerSearchBlockers(page);
  await dismissDealerSearchBlockers(changeContext);

  const popup = await getDealerPopup(page, searchLink, changeContext, normalizedDealerCode);
  await searchDealerInPopup(popup, normalizedDealerCode);

  if (popup !== page && !popup.isClosed()) {
    await popup.waitForEvent('close', { timeout: 1000 }).catch(() => {});
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
