import { logger } from '../utils/logger.js';

export async function waitForKendoGridIdle(page, { gridSelector = '#grid', timeout = 60000 } = {}) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});

  await page.locator('.k-loading-mask, .k-loading-image, .k-loading-color')
    .first()
    .waitFor({ state: 'hidden', timeout: Math.min(timeout, 5000) })
    .catch(() => {});

  const grid = page.locator(gridSelector).first();
  await grid.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) }).catch(() => {});

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
    { timeout: Math.min(timeout, 5000) }
  ).catch(() => {});

  logger.info('Kendo grid appears idle', { gridSelector });
}

async function getEffectiveKendoPagerSize(page, requestedSize) {
  return page.evaluate((requested) => {
    const pagerElement = document.querySelector('.k-pager-wrap, .k-grid-pager');
    if (!pagerElement) {
      return {
        effectiveSize: String(requested),
        totalItems: null,
        selectedPageSize: null,
        visibleRangeSize: null
      };
    }

    const text = pagerElement.innerText || '';
    const rangeInfoMatch = text.match(/\b([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)(?:\s+items?)?\b/i);
    const totalItems = Number.parseInt((rangeInfoMatch?.[3] ?? '').replaceAll(',', ''), 10) || null;
    const rangeStart = Number.parseInt((rangeInfoMatch?.[1] ?? '').replaceAll(',', ''), 10) || null;
    const rangeEnd = Number.parseInt((rangeInfoMatch?.[2] ?? '').replaceAll(',', ''), 10) || null;
    const visibleRangeSize = rangeStart && rangeEnd && rangeEnd >= rangeStart
      ? rangeEnd - rangeStart + 1
      : null;
    const selectedPageSize = Number.parseInt(
      pagerElement.querySelector('.k-pager-sizes select')?.value ||
      pagerElement.querySelector('.k-pager-sizes .k-input')?.textContent?.trim() ||
      '',
      10
    ) || null;
    const requestedPageSize = Number.parseInt(requested, 10) || null;
    const jquery = window.jQuery || window.$;
    const gridElement = document.querySelector('#grid') || document.querySelector('.k-grid');
    const kendoGrid = jquery?.(gridElement).data('kendoGrid') || jquery?.('.k-grid').first().data('kendoGrid');
    const dataSourcePageSize = typeof kendoGrid?.dataSource?.pageSize === 'function'
      ? Number.parseInt(kendoGrid.dataSource.pageSize(), 10) || null
      : null;
    const effectiveSize = selectedPageSize || dataSourcePageSize || requestedPageSize || visibleRangeSize || null;

    return {
      effectiveSize: effectiveSize ? String(effectiveSize) : String(requested),
      totalItems,
      selectedPageSize,
      visibleRangeSize
    };
  }, requestedSize).catch(() => ({
    effectiveSize: String(requestedSize),
    totalItems: null,
    selectedPageSize: null,
    visibleRangeSize: null
  }));
}

async function forceKendoPagerSize(page, requestedSize, { timeout = 60000 } = {}) {
  const changed = await page.evaluate((requested) => {
    const requestedNumber = Number.parseInt(requested, 10);
    if (!Number.isFinite(requestedNumber)) return false;

    const jquery = window.jQuery || window.$;
    const gridElement = document.querySelector('#grid') || document.querySelector('.k-grid');
    const grid = jquery?.(gridElement).data('kendoGrid') || jquery?.('.k-grid').first().data('kendoGrid');
    if (!grid?.dataSource?.pageSize) return false;

    grid.dataSource.pageSize(requestedNumber);
    if (typeof grid.dataSource.page === 'function') {
      grid.dataSource.page(1);
    } else if (typeof grid.dataSource.read === 'function') {
      grid.dataSource.read();
    }
    return true;
  }, String(requestedSize)).catch(() => false);

  if (!changed) {
    return null;
  }

  await waitForKendoGridIdle(page, { timeout });
  return getEffectiveKendoPagerSize(page, requestedSize);
}

export async function selectKendoPagerSize(page, size, { timeout = 30000 } = {}) {
  let effectiveSize = String(size);
  logger.info('Selecting Kendo pager size', { size: effectiveSize });

  const pagerSize = page.locator('.k-pager-sizes').first();
  await pagerSize.waitFor({ state: 'visible', timeout });

  const availableSizes = await page.evaluate(() => {
    const select = document.querySelector('.k-pager-sizes select');
    if (!select) return [];

    return Array.from(select.options)
      .map((option) => (option.value || option.textContent || '').trim())
      .filter(Boolean);
  }).catch(() => []);

  if (availableSizes.length && !availableSizes.includes(effectiveSize)) {
    const forced = await forceKendoPagerSize(page, effectiveSize, { timeout });
    if (forced?.effectiveSize === effectiveSize) {
      logger.info('Forced Kendo pager size through grid data source for visible-click flow', {
        requestedSize: effectiveSize,
        effectiveSize: forced.effectiveSize,
        totalItems: forced.totalItems
      });
      return forced.effectiveSize;
    }

    const numericSizes = availableSizes
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left);
    const requestedNumber = Number.parseInt(effectiveSize, 10);
    const bestAvailableSize = numericSizes.find((value) => (
      Number.isFinite(requestedNumber) ? value <= requestedNumber : true
    )) ?? numericSizes[0];

    const fallbackSize = String(bestAvailableSize ?? availableSizes[0]);

    logger.warn('Requested Kendo pager size is unavailable; using fallback size', {
      requestedSize: effectiveSize,
      fallbackSize,
      availableSizes
    });
    effectiveSize = fallbackSize;
  }

  const changedByWidget = await page.evaluate((requestedSize) => {
    const select = document.querySelector('.k-pager-sizes select');
    if (!select) return false;

    const requestedOption = Array.from(select.options).find((option) => (
      option.value === requestedSize || option.textContent?.trim() === requestedSize
    ));
    if (!requestedOption) return false;

    const jquery = window.jQuery || window.$;
    const dropdown = jquery?.(select).data('kendoDropDownList');
    const grid = jquery?.('#grid').data('kendoGrid') || jquery?.('.k-grid').first().data('kendoGrid');
    if (dropdown) {
      dropdown.value(requestedOption.value);
      dropdown.trigger('change');
      if (grid?.dataSource?.pageSize) {
        grid.dataSource.pageSize(Number.parseInt(requestedOption.value, 10));
        grid.dataSource.page(1);
      }
      return true;
    }

    select.value = requestedOption.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, effectiveSize).catch(() => false);

  if (changedByWidget) {
    await waitForKendoGridIdle(page, { timeout });
    const pager = await getEffectiveKendoPagerSize(page, effectiveSize);
    if (pager.effectiveSize !== effectiveSize) {
      if (effectiveSize !== '300') {
        logger.warn('Kendo pager size did not apply exactly; retrying with 300', {
          requestedSize: effectiveSize,
          effectiveSize: pager.effectiveSize,
          selectedPageSize: pager.selectedPageSize,
          visibleRangeSize: pager.visibleRangeSize,
          totalItems: pager.totalItems,
          fallbackSize: '300'
        });
        return selectKendoPagerSizeByVisibleClick(page, '300', { timeout });
      }

      logger.warn('Kendo pager size did not apply exactly; using visible pager size for pagination', {
        requestedSize: effectiveSize,
        effectiveSize: pager.effectiveSize,
        selectedPageSize: pager.selectedPageSize,
        visibleRangeSize: pager.visibleRangeSize,
        totalItems: pager.totalItems
      });
    }
    return pager.effectiveSize;
  }

  const dropdown = pagerSize.locator('.k-dropdown, .k-dropdownlist, .k-dropdown-wrap, .k-picker').first();
  await dropdown.waitFor({ state: 'visible', timeout });
  await dropdown.click();

  const option = page.locator([
    `.k-list-container li:has-text("${effectiveSize}")`,
    `.k-animation-container li:has-text("${effectiveSize}")`,
    `[role="option"]:has-text("${effectiveSize}")`,
    `li:has-text("${effectiveSize}")`
  ].join(',')).filter({ hasText: effectiveSize }).first();

  try {
    await option.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });
  } catch (error) {
    if (effectiveSize !== '300') {
      logger.warn('Requested Kendo pager option did not appear; retrying with 300', {
        requestedSize: effectiveSize,
        fallbackSize: '300',
        error: error.message
      });
      await page.keyboard.press('Escape').catch(() => {});
      return selectKendoPagerSizeByVisibleClick(page, '300', { timeout });
    }

    throw error;
  }

  await option.click();
  await waitForKendoGridIdle(page, { timeout });
  const pager = await getEffectiveKendoPagerSize(page, effectiveSize);
  if (pager.effectiveSize !== effectiveSize) {
    if (effectiveSize !== '300') {
      logger.warn('Kendo pager option click did not apply exactly; retrying with 300', {
        requestedSize: effectiveSize,
        effectiveSize: pager.effectiveSize,
        selectedPageSize: pager.selectedPageSize,
        visibleRangeSize: pager.visibleRangeSize,
        totalItems: pager.totalItems,
        fallbackSize: '300'
      });
      return selectKendoPagerSizeByVisibleClick(page, '300', { timeout });
    }

    logger.warn('Kendo pager option click did not apply exactly; using visible pager size for pagination', {
      requestedSize: effectiveSize,
      effectiveSize: pager.effectiveSize,
      selectedPageSize: pager.selectedPageSize,
      visibleRangeSize: pager.visibleRangeSize,
      totalItems: pager.totalItems
    });
  }
  return pager.effectiveSize;
}

export async function selectKendoPagerSizeByVisibleClick(page, size, { timeout = 60000 } = {}) {
  let effectiveSize = String(size);
  logger.info('Selecting Kendo pager size by visible click', { size: effectiveSize });

  const pagerSize = page.locator('.k-pager-sizes').first();
  await pagerSize.waitFor({ state: 'visible', timeout });

  const availableSizes = await page.evaluate(() => {
    const select = document.querySelector('.k-pager-sizes select');
    if (!select) return [];

    return Array.from(select.options)
      .map((option) => (option.value || option.textContent || '').trim())
      .filter(Boolean);
  }).catch(() => []);

  if (availableSizes.length && !availableSizes.includes(effectiveSize)) {
    const forced = await forceKendoPagerSize(page, effectiveSize, { timeout });
    if (forced?.effectiveSize === effectiveSize) {
      logger.info('Forced Kendo pager size through grid data source', {
        requestedSize: effectiveSize,
        effectiveSize: forced.effectiveSize,
        totalItems: forced.totalItems
      });
      return forced.effectiveSize;
    }

    const numericSizes = availableSizes
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left);
    const requestedNumber = Number.parseInt(effectiveSize, 10);
    const bestAvailableSize = numericSizes.find((value) => (
      Number.isFinite(requestedNumber) ? value <= requestedNumber : true
    )) ?? numericSizes[0];
    effectiveSize = String(bestAvailableSize ?? availableSizes[0]);

    logger.warn('Requested Kendo pager size is unavailable; using fallback size for visible click', {
      requestedSize: size,
      fallbackSize: effectiveSize,
      availableSizes
    });
  }

  const dropdown = pagerSize.locator('.k-dropdown, .k-dropdownlist, .k-dropdown-wrap, .k-picker, .k-select').first();
  await dropdown.waitFor({ state: 'visible', timeout });
  await dropdown.click({ timeout, force: true });

  const exactText = new RegExp(`^\\s*${String(effectiveSize).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const option = page.locator([
    '.k-list-container:visible li',
    '.k-animation-container:visible li',
    '[role="option"]:visible',
    'li:visible'
  ].join(',')).filter({ hasText: exactText }).first();

  await option.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });
  await option.click({ timeout, force: true });
  await waitForKendoGridIdle(page, { timeout });

  await page.waitForFunction(() => {
    const pagerElement = document.querySelector('.k-pager-wrap, .k-grid-pager');
    const gridElement = document.querySelector('#grid, .k-grid');
    const pagerText = pagerElement?.innerText || '';
    const gridText = gridElement?.innerText || '';
    const loading = document.querySelector('.k-loading-mask, .k-loading-image, .k-loading-color');
    const loadingVisible = loading && window.getComputedStyle(loading).display !== 'none'
      && window.getComputedStyle(loading).visibility !== 'hidden'
      && window.getComputedStyle(loading).opacity !== '0';

    if (loadingVisible) return false;
    return /\bof\s+[\d,]+/i.test(pagerText) || /no\s+records|no\s+data|no\s+items/i.test(gridText);
  }, null, { timeout }).catch(() => {});

  const pager = await getEffectiveKendoPagerSize(page, effectiveSize);
  if (pager.effectiveSize !== effectiveSize) {
    if (effectiveSize !== '300') {
      logger.warn('Kendo visible-click pager size did not apply exactly; retrying with 300', {
        requestedSize: effectiveSize,
        effectiveSize: pager.effectiveSize,
        selectedPageSize: pager.selectedPageSize,
        visibleRangeSize: pager.visibleRangeSize,
        totalItems: pager.totalItems,
        fallbackSize: '300'
      });
      return selectKendoPagerSizeByVisibleClick(page, '300', { timeout });
    }

    logger.warn('Kendo visible-click pager size did not apply exactly; using visible pager size for pagination', {
      requestedSize: effectiveSize,
      effectiveSize: pager.effectiveSize,
      selectedPageSize: pager.selectedPageSize,
      visibleRangeSize: pager.visibleRangeSize,
      totalItems: pager.totalItems
    });
  }
  return pager.effectiveSize;
}
