import { logger } from '../utils/logger.js';

export async function waitForKendoGridIdle(page, { gridSelector = '#grid', timeout = 60000 } = {}) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 15000) }).catch(() => {});

  await page.locator('.k-loading-mask, .k-loading-image, .k-loading-color')
    .first()
    .waitFor({ state: 'hidden', timeout })
    .catch(() => {});

  const grid = page.locator(gridSelector).first();
  await grid.waitFor({ state: 'visible', timeout }).catch(() => {});

  await page.waitForFunction(
    ({ gridSelector: selector }) => {
      const gridElement = document.querySelector(selector);
      if (!gridElement) return true;
      const loading = document.querySelector('.k-loading-mask, .k-loading-image, .k-loading-color');
      if (loading) {
        const style = window.getComputedStyle(loading);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          return false;
        }
      }
      return true;
    },
    { gridSelector },
    { timeout }
  ).catch(() => {});

  logger.info('Kendo grid appears idle', { gridSelector });
}

export async function selectKendoPagerSize(page, size, { timeout = 30000 } = {}) {
  logger.info('Selecting Kendo pager size', { size });

  const pagerSize = page.locator('.k-pager-sizes').first();
  await pagerSize.waitFor({ state: 'visible', timeout });

  const dropdown = pagerSize.locator('.k-dropdown, .k-dropdownlist, .k-dropdown-wrap, .k-picker').first();
  await dropdown.waitFor({ state: 'visible', timeout });
  await dropdown.click();

  const option = page.locator([
    `.k-list-container li:has-text("${size}")`,
    `.k-animation-container li:has-text("${size}")`,
    `[role="option"]:has-text("${size}")`,
    `li:has-text("${size}")`
  ].join(',')).filter({ hasText: String(size) }).first();

  await option.waitFor({ state: 'visible', timeout });
  await option.click();
  await waitForKendoGridIdle(page, { timeout });
}
