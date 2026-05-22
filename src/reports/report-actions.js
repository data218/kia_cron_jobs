import { firstVisible, clickAndWait } from '../playwright/browser.js';
import { logger } from '../utils/logger.js';
import { saveDownloadedExcelToSupabase } from './excel-to-supabase.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  await dropdownWrap.click();

  const option = page.locator([
    `.k-list-container:visible li:has-text("${value}")`,
    `.k-animation-container:visible li:has-text("${value}")`,
    `[role="option"]:visible:has-text("${value}")`,
    `li:visible:has-text("${value}")`
  ].join(',')).filter({ hasText: String(value) }).first();

  await option.waitFor({ state: 'visible', timeout });
  await option.click();
}

export async function selectKendoDropdownByInputId(page, inputId, value, { timeout = 30000 } = {}) {
  logger.info('Selecting dropdown value', { inputId, value });

  const dropdownWrap = page.locator(
    `xpath=//input[@id="${inputId}"]/ancestor::span[contains(@class,"k-widget")][1]//span[contains(@class,"k-dropdown-wrap")]`
  ).first();

  await dropdownWrap.waitFor({ state: 'visible', timeout });
  await dropdownWrap.click();

  const exactText = new RegExp(`^\\s*${escapeRegex(value)}\\s*$`);
  const option = page.locator([
    '.k-list-container:visible li',
    '.k-animation-container:visible li',
    '[role="option"]:visible',
    'li:visible'
  ].join(',')).filter({ hasText: exactText }).first();

  await option.waitFor({ state: 'visible', timeout });
  await option.click();
}
