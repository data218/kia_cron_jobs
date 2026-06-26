import { logger } from '../utils/logger.js';

function resolvePlaywrightPage(context) {
  if (!context) return context;
  if (context.keyboard) return context;
  if (typeof context.page === 'function') return context.page();
  return context;
}

async function dismissOpenKendoDropdown(context) {
  const playwrightPage = resolvePlaywrightPage(context);
  await playwrightPage.keyboard?.press('Escape').catch(() => {});
}

async function checkGridEmptyFast(page) {
  return page.evaluate(() => {
    const isVisible = element => Boolean(element && (
      element.offsetWidth ||
      element.offsetHeight ||
      element.getClientRects().length
    ));

    // Detect warning/error notifications (like "Date is not correct")
    const alerts = Array.from(document.querySelectorAll('.k-window, .k-notification, .k-tooltip, .k-ext-dialog, [role="alert"], div:has(> .warning), .k-window-titlebar, .notification_title'));
    const hasWarning = alerts.some(el => {
      const vis = el.offsetWidth || el.offsetHeight || el.getClientRects().length;
      if (!vis) return false;
      const txt = (el.innerText || el.textContent || '').toLowerCase();
      return txt.includes('warning') || txt.includes('error') || txt.includes('not correct') || txt.includes('incorrect') || txt.includes('date is') || txt.includes('no data');
    });
    if (hasWarning) return { empty: true, reason: 'warning-or-error-dialog' };

    // Check if loading mask is visible
    const loading = document.querySelector('.k-loading-mask, .k-loading-image, .k-loading-color');
    if (loading) {
      const style = window.getComputedStyle(loading);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        return { empty: false, reason: 'grid-is-loading' };
      }
    }

    const gridElement = document.querySelector('#grid, .k-grid');
    if (!gridElement) return { empty: false, reason: 'grid-not-found' };

    // Try Kendo widget check using both jQuery and Kendo API
    const jquery = window.jQuery || window.$;
    let kendoGrid = null;
    if (jquery) {
      kendoGrid = jquery(gridElement).data('kendoGrid') || jquery('.k-grid').first().data('kendoGrid');
    }
    if (!kendoGrid && window.kendo) {
      kendoGrid = window.kendo.widgetInstance(gridElement) || window.kendo.widgetInstance(document.querySelector('.k-grid'));
    }

    if (kendoGrid?.dataSource && typeof kendoGrid.dataSource.total === 'function') {
      if (kendoGrid.dataSource.total() === 0) {
        return { empty: true, reason: 'datasource-total-zero' };
      }
    }

    // Check for Kendo's no records container or class in the grid
    const noRecordsEl = gridElement.querySelector('.k-grid-norecords, .k-norecords');
    if (noRecordsEl && isVisible(noRecordsEl)) {
      return { empty: true, reason: 'k-grid-norecords-element-visible' };
    }

    // Check tbody contents
    const tbody = gridElement.querySelector('.k-grid-content tbody, tbody');
    if (tbody) {
      if (tbody.children.length === 0) {
        return { empty: true, reason: 'tbody-has-no-children' };
      }
      if (tbody.children.length === 1) {
        const child = tbody.children[0];
        if (child.classList.contains('k-no-data') || child.classList.contains('k-grid-norecords') || child.querySelector('.k-grid-norecords, .k-norecords')) {
          return { empty: true, reason: 'tbody-single-child-no-data-class' };
        }
        const text = (child.innerText || child.textContent || '').toLowerCase();
        if (text.includes('no records') || text.includes('no data') || text.includes('no items') || text.includes('no rows')) {
          return { empty: true, reason: 'tbody-single-child-no-data-text' };
        }
      }
    }

    // Check pager text
    const pagerElement = document.querySelector('.k-pager-wrap, .k-grid-pager');
    if (pagerElement && isVisible(pagerElement)) {
      const pagerText = (pagerElement.innerText || pagerElement.textContent || '').toLowerCase();
      if (pagerText.includes('no items') || pagerText.includes('no data') || pagerText.includes('no records') || /0\s*-\s*0\s+of\s+0/i.test(pagerText)) {
        return { empty: true, reason: 'pager-text-indicates-empty' };
      }
    }

    const gridText = (gridElement.innerText || '').toLowerCase();
    if (/no\s+records|no\s+data|no\s+items/i.test(gridText)) {
      return { empty: true, reason: 'grid-no-data-text' };
    }

    return { empty: false, reason: 'has-data-or-loading' };
  }).catch(() => ({ empty: false, reason: 'evaluate-failed' }));
}

async function trySetKendoPagerSizeViaJsApi(page, requestedSize, { gridSelector } = {}) {
  return page.evaluate(({ requested, selector }) => {
    const requestedNumber = Number.parseInt(requested, 10);
    if (!Number.isFinite(requestedNumber)) return false;

    const jquery = window.jQuery || window.$;
    const gridElement = selector
      ? document.querySelector(selector)
      : document.querySelector('#grid, .k-grid');
    const grid = jquery?.(gridElement).data('kendoGrid');
    if (!grid?.dataSource?.pageSize) return false;

    // Set page size and trigger read/page
    grid.dataSource.pageSize(requestedNumber);
    if (typeof grid.dataSource.page === 'function') {
      grid.dataSource.page(1);
    } else if (typeof grid.dataSource.read === 'function') {
      grid.dataSource.read();
    }

    // Try to update the visible dropdown widget if present
    const select = gridElement.querySelector('.k-pager-sizes select');
    const dropdown = jquery?.(select).data('kendoDropDownList');
    if (dropdown && typeof dropdown.value === 'function') {
      dropdown.value(requested);
      dropdown.trigger('change');
    }

    return true;
  }, { requested: String(requestedSize), selector: gridSelector }).catch(() => false);
}

export async function waitForKendoGridIdle(page, { gridSelector = '#grid, .k-grid', timeout = 60000 } = {}) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});

  await page.locator('.k-loading-mask, .k-loading-image, .k-loading-color')
    .first()
    .waitFor({ state: 'hidden', timeout: Math.min(timeout, 30000) })
    .catch(() => {});

  const grid = page.locator(gridSelector).first();
  await grid.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) }).catch(() => {});

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

      // Detect warning/error notification windows
      const alerts = Array.from(document.querySelectorAll('.k-window, .k-notification, .k-tooltip, .k-ext-dialog, [role="alert"], div:has(> .warning), .k-window-titlebar, .notification_title'));
      const hasWarning = alerts.some(el => {
        const vis = el.offsetWidth || el.offsetHeight || el.getClientRects().length;
        if (!vis) return false;
        const txt = (el.innerText || el.textContent || '').toLowerCase();
        return txt.includes('warning') || txt.includes('error') || txt.includes('not correct') || txt.includes('incorrect') || txt.includes('date is');
      });
      if (hasWarning) return true;

      // Check datasource total
      const jquery = window.jQuery || window.$;
      let kendoGrid = null;
      if (jquery) {
        kendoGrid = jquery(gridElement).data('kendoGrid') || jquery('.k-grid').first().data('kendoGrid');
      }
      if (!kendoGrid && window.kendo) {
        kendoGrid = window.kendo.widgetInstance(gridElement) || window.kendo.widgetInstance(document.querySelector('.k-grid'));
      }

      if (kendoGrid?.dataSource && typeof kendoGrid.dataSource.total === 'function') {
        if (kendoGrid.dataSource.total() === 0) {
          return true;
        }
      }

      return true;
    },
    { gridSelector },
    { timeout: Math.min(timeout, 30000) }
  ).catch(() => {});

  // Dismiss any warning/error notification windows or alert dialogs
  await page.evaluate(() => {
    const closeButtons = Array.from(document.querySelectorAll('.k-window:visible .k-i-close, .k-window:visible .k-window-action, .k-notification:visible .k-i-close, button:visible, a.k-button:visible'));
    const okClose = closeButtons.filter(btn => {
      const txt = (btn.innerText || btn.textContent || '').toLowerCase();
      return txt.includes('ok') || txt.includes('close') || btn.classList.contains('k-i-close');
    });
    okClose.forEach(btn => {
      try { btn.click(); } catch(e) {}
    });
  }).catch(() => {});

  logger.info('Kendo grid appears idle', { gridSelector });
}

async function getEffectiveKendoPagerSize(page, requestedSize) {
  return page.evaluate((requested) => {
    const isVisible = element => Boolean(element && (
      element.offsetWidth ||
      element.offsetHeight ||
      element.getClientRects().length
    ));
    const pagerElement = Array.from(document.querySelectorAll('.k-pager-wrap, .k-grid-pager'))
      .find(isVisible);
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
    const gridElement = pagerElement.closest('.k-grid') ||
      Array.from(document.querySelectorAll('#grid, .k-grid')).find(isVisible);
    const kendoGrid = jquery?.(gridElement).data('kendoGrid');
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

    const isVisible = element => Boolean(element && (
      element.offsetWidth ||
      element.offsetHeight ||
      element.getClientRects().length
    ));
    const jquery = window.jQuery || window.$;
    const pagerElement = Array.from(document.querySelectorAll('.k-pager-wrap, .k-grid-pager'))
      .find(isVisible);
    const gridElement = pagerElement?.closest('.k-grid') ||
      Array.from(document.querySelectorAll('#grid, .k-grid')).find(isVisible);
    const grid = jquery?.(gridElement).data('kendoGrid');
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

export async function selectKendoPagerSizeForGrid(page, size, {
  gridId,
  timeout = 60000
} = {}) {
  const requestedSize = String(size);
  logger.info('Selecting Kendo pager size for report grid', { gridId, size: requestedSize });
  const eventPage = typeof page.page === 'function' ? page.page() : page;
  const networkEvents = [];
  const captureRequest = request => {
    if (request.resourceType() !== 'xhr' && request.resourceType() !== 'fetch') return;
    const rawPostData = request.postData() || '';
    const relevantFields = {};
    try {
      const params = new URLSearchParams(rawPostData);
      for (const [key, value] of params) {
        if (/date|page|take|skip|size/i.test(key)) {
          relevantFields[key] = value;
        }
      }
    } catch {
      // Non-form request bodies are intentionally not logged.
    }
    networkEvents.push({
      method: request.method(),
      url: request.url(),
      relevantFields
    });
  };
  eventPage.on('request', captureRequest);

  const result = await page.evaluate(({ requestedSize: requested, gridId: requestedGridId }) => {
    const requestedNumber = Number.parseInt(requested, 10);
    const isVisible = element => Boolean(element && (
      element.offsetWidth ||
      element.offsetHeight ||
      element.getClientRects().length
    ));
    const escape = value => window.CSS?.escape ? window.CSS.escape(value) : value;
    const jquery = window.jQuery || window.$;
    const gridElement = requestedGridId
      ? document.querySelector(`#${escape(requestedGridId)}`)
      : Array.from(document.querySelectorAll('.k-grid')).find(isVisible);
    const pagerElement = gridElement?.querySelector('.k-grid-pager, .k-pager-wrap') ||
      Array.from(document.querySelectorAll('.k-grid-pager, .k-pager-wrap')).find(isVisible);
    const select = pagerElement?.querySelector('.k-pager-sizes select');

    if (!pagerElement || !select || !Number.isFinite(requestedNumber)) {
      return { changed: false, reason: 'pager-or-select-not-found' };
    }

    const option = Array.from(select.options).find(candidate =>
      candidate.value === requested || candidate.textContent?.trim() === requested
    );
    if (!option) {
      return {
        changed: false,
        reason: 'option-not-found',
        availableSizes: Array.from(select.options).map(candidate =>
          (candidate.value || candidate.textContent || '').trim()
        )
      };
    }

    const dropdown = jquery?.(select).data('kendoDropDownList');
    const grid = jquery?.(gridElement).data('kendoGrid');
    select.value = option.value;
    if (dropdown) {
      dropdown.value(option.value);
      dropdown.trigger('change');
    } else {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (grid?.dataSource?.pageSize) {
      grid.dataSource.pageSize(requestedNumber);
      if (typeof grid.dataSource.page === 'function') {
        grid.dataSource.page(1);
      }
    }

    return {
      changed: true,
      gridId: gridElement?.id || null,
      selectedValue: select.value
    };
  }, { requestedSize, gridId }).catch(error => ({
    changed: false,
    reason: error.message
  }));

  if (!result.changed) {
    eventPage.off('request', captureRequest);
    throw new Error(
      `Could not select pager size ${requestedSize} for ${gridId || 'visible grid'}: ` +
      `${result.reason}${result.availableSizes ? ` (${result.availableSizes.join(', ')})` : ''}`
    );
  }

  await waitForKendoGridIdle(page, {
    gridSelector: gridId ? `#${gridId}` : '#grid',
    timeout
  });
  await page.waitForTimeout(300);
  eventPage.off('request', captureRequest);

  logger.info('Hyundai pager change network activity', {
    gridId,
    requestCount: networkEvents.length,
    requests: networkEvents.slice(-5)
  });

  const selectedValue = await page.evaluate((requestedGridId) => {
    const escape = value => window.CSS?.escape ? window.CSS.escape(value) : value;
    const gridElement = requestedGridId
      ? document.querySelector(`#${escape(requestedGridId)}`)
      : Array.from(document.querySelectorAll('.k-grid')).find(element =>
        element.offsetWidth || element.offsetHeight || element.getClientRects().length
      );
    return gridElement
      ?.querySelector('.k-grid-pager .k-pager-sizes select, .k-pager-wrap .k-pager-sizes select')
      ?.value || null;
  }, gridId);

  if (selectedValue !== requestedSize) {
    throw new Error(
      `Pager size for ${gridId || 'visible grid'} is ${selectedValue || 'unknown'}, expected ${requestedSize}`
    );
  }

  return requestedSize;
}

export async function selectKendoPagerSize(page, size, { timeout = 30000 } = {}) {
  let effectiveSize = String(size);
  logger.info('Selecting Kendo pager size', { size: effectiveSize });

  const currentPager = await getEffectiveKendoPagerSize(page, effectiveSize);
  if (currentPager.effectiveSize === effectiveSize) {
    logger.info('Kendo pager size is already at target size; skipping selection', { size: effectiveSize });
    return effectiveSize;
  }

  const pagerSize = page.locator('.k-pager-sizes:visible').first();

  let isPagerVisible = false;
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    isPagerVisible = await pagerSize.isVisible().catch(() => false);
    if (isPagerVisible) {
      break;
    }

    const emptyResult = await checkGridEmptyFast(page);
    if (emptyResult.empty) {
      logger.warn('Kendo pager size container is not visible and grid has no data, skipping pager selection', {
        reason: emptyResult.reason
      });
      return effectiveSize;
    }

    await page.waitForTimeout(500);
  }

  if (!isPagerVisible) {
    const emptyResult = await checkGridEmptyFast(page);
    if (emptyResult.empty) {
      logger.warn('Kendo pager size container is not visible and grid has no data after timeout, skipping pager selection', {
        reason: emptyResult.reason
      });
      return effectiveSize;
    }
    throw new Error(`Timeout waiting for Kendo pager sizes to be visible (${timeout}ms)`);
  }

  const availableSizes = await page.evaluate(() => {
    const select = Array.from(document.querySelectorAll('.k-pager-sizes select'))
      .find(element => element.offsetWidth || element.offsetHeight || element.getClientRects().length);
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
    const select = Array.from(document.querySelectorAll('.k-pager-sizes select'))
      .find(element => element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    if (!select) return false;

    const requestedOption = Array.from(select.options).find((option) => (
      option.value === requestedSize || option.textContent?.trim() === requestedSize
    ));
    if (!requestedOption) return false;

    const jquery = window.jQuery || window.$;
    const dropdown = jquery?.(select).data('kendoDropDownList');
    const gridElement = select.closest('.k-grid');
    const grid = jquery?.(gridElement).data('kendoGrid');
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
      await dismissOpenKendoDropdown(page);
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

export async function selectKendoPagerSizeByVisibleClick(page, size, {
  timeout = 60000,
  resultSettleTimeoutMs = timeout,
  gridSelector
} = {}) {
  let effectiveSize = String(size);
  logger.info('Selecting Kendo pager size by visible click', { size: effectiveSize });

  const currentPager = await getEffectiveKendoPagerSize(page, effectiveSize);
  if (currentPager.effectiveSize === effectiveSize) {
    logger.info('Kendo pager size is already at target size (visible click); skipping selection', { size: effectiveSize });
    return effectiveSize;
  }

  const pagerSize = gridSelector
    ? page.locator(`${gridSelector} .k-pager-sizes`).first()
    : page.locator('.k-pager-sizes:visible').first();

  let isPagerVisible = false;
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    isPagerVisible = await pagerSize.isVisible().catch(() => false);
    if (isPagerVisible) {
      break;
    }

    const emptyResult = await checkGridEmptyFast(page);
    if (emptyResult.empty) {
      logger.warn('Kendo pager size container is not visible and grid has no data (visible click), skipping pager selection', {
        reason: emptyResult.reason
      });
      return effectiveSize;
    }

    await page.waitForTimeout(500);
  }

  if (!isPagerVisible) {
    const emptyResult = await checkGridEmptyFast(page);
    if (emptyResult.empty) {
      logger.warn('Kendo pager size container is not visible and grid has no data after timeout (visible click), skipping pager selection', {
        reason: emptyResult.reason
      });
      return effectiveSize;
    }
    throw new Error(`Timeout waiting for Kendo pager sizes to be visible by visible click (${timeout}ms)`);
  }

  const availableSizes = await page.evaluate((selector) => {
    const root = selector ? document.querySelector(selector) : document;
    const select = Array.from(root?.querySelectorAll('.k-pager-sizes select') || [])
      .find(element => selector || element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    if (!select) return [];

    return Array.from(select.options)
      .map((option) => (option.value || option.textContent || '').trim())
      .filter(Boolean);
  }, gridSelector).catch(() => []);

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
    const isVisible = element => Boolean(element && (
      element.offsetWidth ||
      element.offsetHeight ||
      element.getClientRects().length
    ));
    const pagerElement = Array.from(document.querySelectorAll('.k-pager-wrap, .k-grid-pager'))
      .find(isVisible);
    const gridElement = pagerElement?.closest('.k-grid') ||
      Array.from(document.querySelectorAll('#grid, .k-grid')).find(isVisible);
    const pagerText = pagerElement?.innerText || '';
    const gridText = gridElement?.innerText || '';
    const loading = document.querySelector('.k-loading-mask, .k-loading-image, .k-loading-color');
    const loadingVisible = loading && window.getComputedStyle(loading).display !== 'none'
      && window.getComputedStyle(loading).visibility !== 'hidden'
      && window.getComputedStyle(loading).opacity !== '0';
    if (loadingVisible) return false;

    // Detect warning/error notification windows
    const alerts = Array.from(document.querySelectorAll('.k-window, .k-notification, .k-tooltip, .k-ext-dialog, [role="alert"], div:has(> .warning), .k-window-titlebar, .notification_title'));
    const hasWarning = alerts.some(el => {
      const vis = el.offsetWidth || el.offsetHeight || el.getClientRects().length;
      if (!vis) return false;
      const txt = (el.innerText || el.textContent || '').toLowerCase();
      return txt.includes('warning') || txt.includes('error') || txt.includes('not correct') || txt.includes('incorrect') || txt.includes('date is');
    });
    if (hasWarning) return true;

    // Check datasource total
    const jquery = window.jQuery || window.$;
    let kendoGrid = null;
    if (jquery) {
      kendoGrid = jquery(gridElement).data('kendoGrid') || jquery('.k-grid').first().data('kendoGrid');
    }
    if (!kendoGrid && window.kendo) {
      kendoGrid = window.kendo.widgetInstance(gridElement) || window.kendo.widgetInstance(document.querySelector('.k-grid'));
    }
    if (kendoGrid?.dataSource && typeof kendoGrid.dataSource.total === 'function') {
      if (kendoGrid.dataSource.total() === 0) {
        return true;
      }
    }

    // Check for Kendo's no records container or class in the grid
    if (gridElement) {
      const noRecordsEl = gridElement.querySelector('.k-grid-norecords, .k-norecords');
      if (noRecordsEl && isVisible(noRecordsEl)) {
        return true;
      }

      // Check tbody contents
      const tbody = gridElement.querySelector('.k-grid-content tbody, tbody');
      if (tbody) {
        if (tbody.children.length === 0) {
          return true;
        }
        if (tbody.children.length === 1) {
          const child = tbody.children[0];
          if (child.classList.contains('k-no-data') || child.classList.contains('k-grid-norecords') || child.querySelector('.k-grid-norecords, .k-norecords')) {
            return true;
          }
          const text = (child.innerText || child.textContent || '').toLowerCase();
          if (text.includes('no records') || text.includes('no data') || text.includes('no items')) {
            return true;
          }
        }
      }
    }

    // Check pager text for no data
    if (pagerText.toLowerCase().includes('no items') || pagerText.toLowerCase().includes('no data') || pagerText.toLowerCase().includes('no records') || /0\s*-\s*0\s+of\s+0/i.test(pagerText)) {
      return true;
    }

    return /\bof\s+[\d,]+/i.test(pagerText) || /no\s+records|no\s+data|no\s+items/i.test(gridText);
  }, null, { timeout: resultSettleTimeoutMs }).catch(() => {});

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

export async function selectKendoPagerSizeWithPreferredFallback(page, preferredSizes = ['1000', '500', '300'], {
  visibleClick = false,
  timeout = 60000,
  resultSettleTimeoutMs,
  gridSelector
} = {}) {
  const emptyResult = await checkGridEmptyFast(page);
  if (emptyResult.empty) {
    logger.info('Grid is empty/no data; skipping pager size fallbacks', { reason: emptyResult.reason });
    return String(preferredSizes[0]);
  }

  // Next, try the JS API fast path for the first preferred size
  const targetSize = String(preferredSizes[0]);
  logger.info('Attempting Kendo JS API pager size selection fast-path', { size: targetSize });
  const jsApiSuccess = await trySetKendoPagerSizeViaJsApi(page, targetSize, { gridSelector });
  if (jsApiSuccess) {
    await waitForKendoGridIdle(page, { gridSelector: gridSelector || '#grid', timeout: 15000 }).catch(() => {});
    const pager = await getEffectiveKendoPagerSize(page, targetSize);
    if (pager.effectiveSize === targetSize) {
      logger.info('Successfully set Kendo pager size via JS API fast-path', { size: targetSize });
      return targetSize;
    }
    logger.warn('JS API page size verification did not match requested size, falling back to standard methods', {
      requested: targetSize,
      actual: pager.effectiveSize
    });
  }

  const selectFn = visibleClick ? selectKendoPagerSizeByVisibleClick : selectKendoPagerSize;
  const options = { timeout, resultSettleTimeoutMs, gridSelector };
  let lastError;

  for (const size of preferredSizes) {
    try {
      const selected = await selectFn(page, size, options);
      logger.info('Applied Kendo pager size from preferred fallback list', {
        preferredSizes,
        requestedSize: size,
        selectedSize: selected,
        visibleClick
      });
      return selected;
    } catch (error) {
      lastError = error;
      logger.warn('Preferred Kendo pager size failed; trying next size', {
        size,
        preferredSizes,
        visibleClick,
        error: error.message
      });
    }
  }

  throw lastError ?? new Error(`Could not select any pager size from ${preferredSizes.join(', ')}`);
}
