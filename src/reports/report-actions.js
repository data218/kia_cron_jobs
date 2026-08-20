import { firstVisible, clickAndWait } from '../playwright/browser.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { saveDownloadedExcelToSupabase } from './excel-to-supabase.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Report contexts are often a Frame, not a Page, and Frame has no `.keyboard`.
// `frame.keyboard.press(...)` throws a TypeError synchronously, so a trailing
// `.catch()` never sees it — resolve the owning Page instead.
function ownerPage(context) {
  return typeof context?.page === 'function' ? context.page() : context;
}

async function pressEscape(context) {
  const owner = ownerPage(context);
  if (!owner?.keyboard) return;
  await owner.keyboard.press('Escape').catch(() => {});
}

async function dismissKendoCommonMessages(page) {
  const messageContainers = page.locator([
    '.k-animation-container:visible:has(.notification_title:has-text("Common Message"))',
    '.k-window:visible:has(.notification_title:has-text("Common Message"))'
  ].join(','));

  const count = await messageContainers.count().catch(() => 0);
  if (!count) return;

  logger.warn('Dismissing blocking Kendo common message popup', { count });

  for (let index = 0; index < count; index += 1) {
    const container = messageContainers.nth(index);
    const closeButton = container.locator([
      '.k-i-close',
      '.k-window-action',
      '.btn_close',
      'button:has-text("OK")',
      'button:has-text("Close")',
      '[aria-label="Close"]'
    ].join(',')).first();

    if (await closeButton.count().catch(() => 0)) {
      await closeButton.click({ timeout: 1500, force: true }).catch(() => {});
    }
  }

  await pressEscape(page);
}

async function setKendoDropdownByInputId(page, inputId, value) {
  const input = page.locator(`#${inputId}`).first();
  if (!(await input.count().catch(() => 0))) return false;

  return input.evaluate((element, selectedText) => {
    const win = element.ownerDocument?.defaultView;
    const jquery = win?.jQuery ?? win?.$;
    if (!jquery) return false;

    const widget = jquery(element).data('kendoDropDownList') ??
      jquery(element).data('kendoExtDropDownList') ??
      jquery(element).data('extdropdownlist');
    if (!widget) return false;

    const dataItems = widget.dataSource?.view?.() ??
      widget.dataSource?.data?.() ??
      [];
    const expected = String(selectedText).trim();
    const index = Array.from(dataItems).findIndex(item => {
      const text = typeof item === 'string'
        ? item
        : item?.text ?? item?.Text ?? item?.name ?? item?.Name ?? item?.value ?? item?.Value ?? '';
      return String(text).trim() === expected;
    });

    if (index < 0) return false;

    widget.select(index);
    if (typeof widget.trigger === 'function') {
      widget.trigger('change');
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }, value).catch(() => false);
}

/**
 * Selects a data item on a Kendo (Ext)DropDownList by matching `code` against ANY field of
 * the bound data item — GDMS dealer dropdowns expose the code as `sprDlrCode`/`dlrCode`
 * while the visible text lives in `mainDlrName`, so text-only matching is not enough.
 *
 * Two portal-specific details this handles:
 *  - the dataSource binds lazily, so an empty view is re-read before matching;
 *  - `optionLabel` occupies rendered index 0, so a data-item index must be shifted by one
 *    before being handed to `widget.select()`.
 */
async function selectKendoDataItemByCode(page, inputId, code) {
  const input = page.locator(`#${inputId}`).first();
  if (!(await input.count().catch(() => 0))) return { ok: false, reason: 'input missing' };

  return input.evaluate(async (element, wanted) => {
    const win = element.ownerDocument?.defaultView;
    const jquery = win?.jQuery ?? win?.$;
    if (!jquery) return { ok: false, reason: 'jquery missing' };

    const bag = jquery(element).data() || {};
    const key = Object.keys(bag).find(name => {
      const candidate = bag[name];
      return candidate && typeof candidate.select === 'function' && candidate.dataSource;
    });
    const widget = key ? bag[key] : null;
    if (!widget) return { ok: false, reason: 'widget missing' };

    let view = widget.dataSource.view?.() ?? [];
    if (!view.length) {
      try {
        await widget.dataSource.read();
        view = widget.dataSource.view?.() ?? [];
      } catch (error) {
        return { ok: false, reason: `dataSource.read failed: ${error?.message ?? error}` };
      }
    }

    const items = Array.from(view);
    if (!items.length) return { ok: false, reason: 'dataSource empty' };

    const textField = widget.options?.dataTextField;
    let matchedField = null;
    const index = items.findIndex(item => Object.entries(item ?? {}).some(([field, value]) => {
      const hit = String(value ?? '').toUpperCase().includes(wanted);
      if (hit) matchedField = field;
      return hit;
    }));

    if (index < 0) {
      return {
        ok: false,
        reason: 'no data item matched',
        options: items.map(item => String(item?.[textField] ?? ''))
      };
    }

    // optionLabel renders as row 0, pushing real data items down by one.
    const optionLabel = widget.options?.optionLabel;
    const offset = optionLabel === undefined || optionLabel === null ? 0 : 1;

    widget.select(index + offset);
    if (typeof widget.trigger === 'function') widget.trigger('change');
    element.dispatchEvent(new Event('change', { bubbles: true }));

    return { ok: true, matchedField, selectedIndex: index + offset };
  }, code).catch(error => ({ ok: false, reason: error.message }));
}

async function clickDropdownOption(page, option, { timeout, value, source }) {
  await option.waitFor({ state: 'visible', timeout });

  try {
    await option.click({ timeout });
    return;
  } catch (error) {
    logger.warn('Dropdown option click failed; retrying after popup cleanup', {
      value,
      source,
      error: error.message
    });
    await dismissKendoCommonMessages(page);
    await option.click({ timeout: 5000, force: true });
  }
}

export async function fillDate(page, selector, value) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  try {
    await input.fill('');
    await input.fill(value);
  } catch {
    await input.evaluate((element, nextValue) => {
      element.removeAttribute('readonly');
      element.value = nextValue;
    }, value);
  }

  await input.evaluate((element, nextValue) => {
    element.removeAttribute('readonly');
    element.value = nextValue;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));

    const win = element.ownerDocument?.defaultView;
    const kendo = win?.kendo;
    const jquery = win?.jQuery ?? win?.$;
    const [day, month, year] = String(nextValue)
      .split(/[./-]/)
      .map(part => Number.parseInt(part, 10));
    const widgetDate = Number.isFinite(day) && Number.isFinite(month) && Number.isFinite(year)
      ? new Date(year, month - 1, day)
      : nextValue;
    if (kendo && jquery) {
      const widget = jquery(element).data('kendoDatePicker') ??
        jquery(element).data('kendoMaskedTextBox') ??
        jquery(element).data('kendoExtMaskedDatePicker') ??
        jquery(element).data('extmaskeddatepicker');
      if (widget?.value) {
        widget.value(widgetDate);
      }
      if (widget?.trigger) {
        widget.trigger('change');
      }
    }

    element.value = nextValue;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);

  await input.press('Tab').catch(() => {});
}

function formatLongDateLabel(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

export async function pickKendoDateViaCalendar(page, selector, targetDate) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });

  const pickerWrap = input.locator('xpath=ancestor::*[contains(@class,"k-datepicker") or contains(@class,"k-picker-wrap")][1]');
  const calendarIcon = pickerWrap.locator([
    'span.k-icon.k-i-calendar',
    '.k-select',
    'span.k-select'
  ].join(',')).first();

  if (await calendarIcon.isVisible({ timeout: 2000 }).catch(() => false)) {
    await calendarIcon.click({ force: true });
  } else {
    await input.click({ force: true });
  }

  const calendar = page.locator([
    '.k-animation-container:visible .k-calendar',
    '.k-calendar:visible'
  ].join(',')).first();
  await calendar.waitFor({ state: 'visible', timeout: 15000 });

  const longLabel = formatLongDateLabel(targetDate);
  const dayText = String(targetDate.getDate());
  const footer = calendar.locator('.k-footer').first();
  const footerLink = footer.locator(`a:has-text("${longLabel}"), .k-footer:has-text("${longLabel}")`).first();

  if (await footerLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await footerLink.click({ force: true });
  } else {
    const todayLink = calendar.locator('.k-nav-today, a.k-nav-today').first();
    if (await todayLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      await todayLink.click({ force: true });
    } else {
      const dayCell = calendar.locator([
        `td:not(.k-other-month) a.k-link:text-is("${dayText}")`,
        `td:not(.k-other-month) .k-link:text-is("${dayText}")`,
        `a.k-link:text-is("${dayText}")`
      ].join(',')).first();
      await dayCell.waitFor({ state: 'visible', timeout: 10000 });
      await dayCell.click({ force: true });
    }
  }

  await calendar.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  await pressEscape(page);

  const expectedPortal = [
    String(targetDate.getDate()).padStart(2, '0'),
    String(targetDate.getMonth() + 1).padStart(2, '0'),
    String(targetDate.getFullYear())
  ].join('/');

  const actual = (await input.inputValue()).trim();
  if (actual !== expectedPortal) {
    await fillDate(page, selector, expectedPortal);
  }

  const verified = (await input.inputValue()).trim();
  if (verified !== expectedPortal) {
    throw new Error(`Calendar date pick failed for ${selector}. Expected ${expectedPortal}, got ${verified}`);
  }

  logger.info('Kendo calendar date selected', { selector, value: verified });
}

export async function getInputValue(page, selector) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  return input.inputValue();
}

export async function clickSearch(page) {
  await dismissKendoCommonMessages(page);

  const searchButton = await firstVisible(page, [
    'div.btn_right #btnSearch',
    '#btnSearch',
    'button.btn_search:has-text("Search")',
    'button:has-text("Search")'
  ], 30000);

  await clickAndWait(page, searchButton, 30000);
}

export async function exportExcelToSupabase(page, { sheetName, filenameBase }) {
  const exportButton = await firstVisible(page, [
    'a.k-grid-excel[onclick*="excelExportToKendoGrid"]',
    'a.k-grid-excel',
    'a[role="button"].k-grid-excel',
    'a:has(.k-i-file-excel)'
  ], 30000);

  const eventPage = typeof page.page === 'function' ? page.page() : page;
  const downloadPromise = eventPage.waitForEvent('download', { timeout: 120000 });
  await exportButton.click();
  const download = await downloadPromise;

  logger.info('Report download captured; sending to Supabase', {
    sheetName,
    suggestedFilename: download.suggestedFilename()
  });

  return saveDownloadedExcelToSupabase(download, {
    brand: 'kia',
    sheetName,
    filenameBase
  });
}

export async function selectKendoDropdownByLabel(page, label, value, { timeout = 30000 } = {}) {
  logger.info('Selecting dropdown value', { label, value });

  const dropdownWrap = page.locator(
    `xpath=//dt[normalize-space(.)="${label}"]/following-sibling::dd[1]//span[contains(@class,"k-dropdown-wrap")]`
  ).first();

  await dropdownWrap.waitFor({ state: 'visible', timeout });
  await dismissKendoCommonMessages(page);
  await dropdownWrap.click();

  const option = page.locator([
    `.k-list-container:visible li:has-text("${value}")`,
    `.k-animation-container:visible li:has-text("${value}")`,
    `[role="option"]:visible:has-text("${value}")`,
    `li:visible:has-text("${value}")`
  ].join(',')).filter({ hasText: String(value) }).first();

  await clickDropdownOption(page, option, { timeout, value, source: label });
}

export async function selectKendoDropdownByInputId(page, inputId, value, { timeout = 30000 } = {}) {
  logger.info('Selecting dropdown value', { inputId, value });

  const dropdownWrap = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]//span[contains(@class,"k-dropdown-wrap")]`
  ).first();

  await dropdownWrap.waitFor({ state: 'visible', timeout });
  await dismissKendoCommonMessages(page);
  await dropdownWrap.click();

  const selectedWithWidget = await setKendoDropdownByInputId(page, inputId, value);
  if (selectedWithWidget) {
    logger.info('Selected Kendo dropdown value through widget API', { inputId, value });
    return;
  }

  const exactText = new RegExp(`^\\s*${escapeRegex(value)}\\s*$`);
  const option = page.locator([
    '.k-list-container:visible li',
    '.k-animation-container:visible li',
    '[role="option"]:visible',
    'li:visible'
  ].join(',')).filter({ hasText: exactText }).first();

  await clickDropdownOption(page, option, { timeout, value, source: inputId });
}

/**
 * Selects a Kendo dropdown option by substring instead of exact text.
 *
 * Written for the GDMS `data-role="extdropdownlist"` widgets whose dataSource is bound
 * lazily: until the popup is opened for the first time the widget holds zero data items,
 * so any widget-API `select()` call silently no-ops and the visible `.k-input` stays blank.
 * Opening the popup first is what makes the options exist at all.
 *
 * Matching is a case-insensitive substring so a dealer code selects
 * `[N5216] JAMMU AUTO MART PVT.LTD.`, and the visible input is read back afterwards so a
 * selection that did not stick is retried rather than reported as success.
 *
 * Returns the selected option text, or null when nothing could be selected.
 */
export async function selectKendoDropdownOptionContaining(page, inputId, needle, {
  timeout = 30000,
  attempts = 3,
  optionTimeout = 15000
} = {}) {
  const target = String(needle ?? '').trim().toUpperCase();
  const widget = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]`
  ).first();

  if (!(await widget.count().catch(() => 0))) {
    logger.info('Kendo dropdown not present on this view; skipping selection', { inputId });
    return null;
  }

  const wrap = widget.locator('.k-dropdown-wrap').first();
  const display = widget.locator('.k-input').first();
  const listboxId = (await widget.getAttribute('aria-owns').catch(() => null)) || `${inputId}_listbox`;

  const readDisplay = async () => String(
    (await display.textContent().catch(() => '')) ?? ''
  ).replace(/ /g, ' ').trim();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const current = await readDisplay();
    if (target && current.toUpperCase().includes(target)) {
      logger.info('Kendo dropdown already shows the requested option', { inputId, value: current });
      return current;
    }

    await dismissKendoCommonMessages(page);
    await wrap.waitFor({ state: 'visible', timeout });

    // Normalise to closed, otherwise the click below would toggle the popup shut.
    if ((await widget.getAttribute('aria-expanded').catch(() => null)) === 'true') {
      await pressEscape(page);
      await sleep(200);
    }

    await wrap.click({ timeout: 10000 }).catch(() => {});

    const options = page.locator(`#${listboxId} > li`);
    await options.first().waitFor({ state: 'visible', timeout: optionTimeout }).catch(() => {});

    const texts = (await options.evaluateAll(nodes => nodes.map(
      node => (node.textContent ?? '').replace(/ /g, ' ').trim()
    )).catch(() => []));

    logger.info('Kendo dropdown options loaded', {
      inputId,
      attempt,
      optionCount: texts.length,
      options: texts.slice(0, 20)
    });

    // Preferred path: drive the widget directly. Clicking the <li> is unreliable here —
    // the popup can stay aria-hidden — and a naive select(n) picks the wrong row, because
    // when the widget defines an optionLabel Kendo renders it at index 0 and shifts every
    // real data item down by one.
    const viaWidget = await selectKendoDataItemByCode(page, inputId, target);
    if (viaWidget?.ok) {
      await sleep(300);
      const selectedByWidget = await readDisplay();
      if (selectedByWidget && (!target || selectedByWidget.toUpperCase().includes(target))) {
        logger.info('Selected Kendo dropdown option via widget API', {
          inputId,
          value: selectedByWidget,
          matchedField: viaWidget.matchedField,
          attempt
        });
        await pressEscape(page);
        return selectedByWidget;
      }
    } else if (viaWidget?.reason) {
      logger.warn('Kendo widget API could not select the option', {
        inputId,
        attempt,
        reason: viaWidget.reason,
        available: viaWidget.options
      });
    }

    let index = target ? texts.findIndex(text => text.toUpperCase().includes(target)) : -1;
    if (index < 0) {
      index = texts.findIndex(text => text.length > 0);
      if (index >= 0 && target) {
        logger.warn('Kendo dropdown had no option matching the requested value; using first non-blank option', {
          inputId,
          requested: target,
          fallback: texts[index]
        });
      }
    }

    if (index >= 0) {
      await options.nth(index).click({ timeout: 10000, force: true }).catch(() => {});
      await sleep(400);

      const selected = await readDisplay();
      if (selected && (!target || selected.toUpperCase().includes(target))) {
        logger.info('Selected Kendo dropdown option', { inputId, value: selected, attempt });
        return selected;
      }

      logger.warn('Kendo dropdown selection did not stick; retrying', {
        inputId,
        attempt,
        requested: target,
        actual: selected
      });
    } else {
      logger.warn('Kendo dropdown popup produced no options', { inputId, attempt });
    }

    await pressEscape(page);
    await sleep(1000);
  }

  return null;
}

/**
 * Lists the option texts a Kendo dropdown actually offers, opening the popup first so a
 * lazily-bound dataSource is populated. Used to discover which dealers a login really
 * exposes rather than assuming a hardcoded list.
 */
export async function listKendoDropdownOptions(page, inputId, { timeout = 30000 } = {}) {
  const widget = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]`
  ).first();

  if (!(await widget.count().catch(() => 0))) return [];

  const wrap = widget.locator('.k-dropdown-wrap').first();
  const listboxId = (await widget.getAttribute('aria-owns').catch(() => null)) || `${inputId}_listbox`;

  await wrap.waitFor({ state: 'visible', timeout }).catch(() => {});
  if ((await widget.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
    await wrap.click({ timeout: 10000 }).catch(() => {});
  }

  const options = page.locator(`#${listboxId} > li`);
  await options.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  const texts = (await options.evaluateAll(nodes => nodes.map(
    node => (node.textContent ?? '').replace(/ /g, ' ').trim()
  )).catch(() => [])).filter(Boolean);

  await pressEscape(page);
  return texts;
}

export async function getKendoDropdownOptionsByInputId(page, inputId, {
  timeout = 30000,
  excludeValues = []
} = {}) {
  const widget = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]`
  ).first();
  const dropdownWrap = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]//span[contains(@class,"k-dropdown-wrap")]`
  ).first();

  await dropdownWrap.waitFor({ state: 'visible', timeout });

  const widgetOptions = await page.locator(`#${inputId}`).first().evaluate(element => {
    const win = element.ownerDocument?.defaultView;
    const jquery = win?.jQuery ?? win?.$;
    const widgetInstance = jquery?.(element).data('kendoDropDownList') ??
      jquery?.(element).data('kendoExtDropDownList') ??
      jquery?.(element).data('extdropdownlist');
    const dataItems = widgetInstance?.dataSource?.view?.() ??
      widgetInstance?.dataSource?.data?.() ??
      [];

    return Array.from(dataItems).map(item => {
      if (typeof item === 'string') return item;
      return item?.text ?? item?.Text ?? item?.name ?? item?.Name ?? item?.value ?? item?.Value ?? '';
    });
  }).catch(() => []);

  let texts = widgetOptions
    .map(value => String(value ?? '').trim())
    .filter(Boolean);

  if (!texts.length) {
    const ownedListboxId = await widget.getAttribute('aria-owns').catch(() => null);
    const listboxId = ownedListboxId || `${inputId}_listbox`;

    await dropdownWrap.click();
    const listItems = page.locator(`#${listboxId} li, #${listboxId} [role="option"]`);
    await listItems.first().waitFor({ state: 'visible', timeout }).catch(() => {});
    texts = await listItems.evaluateAll(elements => elements
      .map(element => element.textContent?.trim() ?? '')
      .filter(Boolean));
    await dropdownWrap.click().catch(() => {});
  }

  const excluded = new Set([
    '',
    'select',
    'all',
    ...excludeValues.map(value => String(value).trim().toLowerCase())
  ]);
  const seen = new Set();

  return texts.filter(text => {
    const normalized = String(text ?? '').trim();
    const key = normalized.toLowerCase();
    if (!normalized || excluded.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function fillDateRange(page, startSelector, endSelector, startDateVal, endDateVal) {
  const startInput = page.locator(startSelector).first();
  const endInput = page.locator(endSelector).first();
  
  await startInput.waitFor({ state: 'visible', timeout: 30000 });
  await endInput.waitFor({ state: 'visible', timeout: 30000 });
  
  await page.evaluate(({ startSel, endSel, startVal, endVal }) => {
    const startEl = document.querySelector(startSel);
    const endEl = document.querySelector(endSel);
    if (!startEl || !endEl) return;

    const setWidgetVal = (element, nextValue) => {
      element.removeAttribute('readonly');
      element.value = nextValue;
      
      const win = element.ownerDocument?.defaultView;
      const kendo = win?.kendo;
      const jquery = win?.jQuery ?? win?.$;
      const [day, month, year] = String(nextValue)
        .split(/[./-]/)
        .map(part => Number.parseInt(part, 10));
      const widgetDate = Number.isFinite(day) && Number.isFinite(month) && Number.isFinite(year)
        ? new Date(year, month - 1, day)
        : nextValue;
      
      if (kendo && jquery) {
        const widget = jquery(element).data('kendoDatePicker') ??
          jquery(element).data('kendoMaskedTextBox') ??
          jquery(element).data('kendoExtMaskedDatePicker') ??
          jquery(element).data('extmaskeddatepicker');
        if (widget?.value) {
          widget.value(widgetDate);
        }
        return widget;
      }
      return null;
    };

    const startWidget = setWidgetVal(startEl, startVal);
    const endWidget = setWidgetVal(endEl, endVal);

    startEl.dispatchEvent(new Event('input', { bubbles: true }));
    startEl.dispatchEvent(new Event('change', { bubbles: true }));
    startEl.dispatchEvent(new Event('blur', { bubbles: true }));

    endEl.dispatchEvent(new Event('input', { bubbles: true }));
    endEl.dispatchEvent(new Event('change', { bubbles: true }));
    endEl.dispatchEvent(new Event('blur', { bubbles: true }));

    if (startWidget?.trigger) {
      startWidget.trigger('change');
    }
    if (endWidget?.trigger) {
      endWidget.trigger('change');
    }
  }, {
    startSel: startSelector,
    endSel: endSelector,
    startVal: startDateVal,
    endVal: endDateVal
  });

  await startInput.press('Tab').catch(() => {});
  await endInput.press('Tab').catch(() => {});
}

