import { firstVisible, clickAndWait } from '../playwright/browser.js';
import { logger } from '../utils/logger.js';
import { saveDownloadedExcelToSupabase } from './excel-to-supabase.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  await page.keyboard.press('Escape').catch(() => {});
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
    if (kendo && jquery) {
      const widget = jquery(element).data('kendoDatePicker') ??
        jquery(element).data('kendoMaskedTextBox') ??
        jquery(element).data('kendoExtMaskedDatePicker') ??
        jquery(element).data('extmaskeddatepicker');
      if (widget?.value) {
        widget.value(nextValue);
      }
      if (widget?.trigger) {
        widget.trigger('change');
      }
    }
  }, value);

  await input.press('Tab').catch(() => {});
}

export async function getInputValue(page, selector) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  return input.inputValue();
}

export async function clickSearch(page) {
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
