import fs from 'node:fs/promises';
import path from 'node:path';
import { config, requireSecret } from '../config.js';
import { firstVisible, saveSessionStateToPath } from '../playwright/browser.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { getCurrentMonthToDateRange, getReportDateOverrideRange, getThirtyDayChunks, parseIsoLocalDate, toIsoDate } from '../utils/date-range.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { cleanupReportExportDir, mergeExcelFiles } from './paged-export.js';
import { fillDate } from './report-actions.js';

function formatDateForRsa(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return `${mm}/${dd}/${yyyy}`;
}

function buildRunDir() {
  const now = new Date();
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('-');

  return path.join(config.reportChunksDir, 'rsa-report', `${toIsoDate(now)}_${time}`);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(label, multiplier = 1) {
  const min = Math.max(0, config.rsaHumanDelayMinMs);
  const max = Math.max(min, config.rsaHumanDelayMaxMs);
  const delayMs = Math.round(randomInt(min, max) * multiplier);

  if (delayMs <= 0) {
    return;
  }

  logger.info('Human-like RSA pause', { label, delayMs });
  await sleep(delayMs);
}

async function humanFill(locator, value, label) {
  await locator.click();
  await humanPause(`${label} focus`, 0.5);
  await locator.fill('');
  await locator.type(String(value), { delay: config.rsaTypingDelayMs });
  await humanPause(`${label} typed`, 0.5);
}

async function waitForRsaDataIdle(page) {
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.locator([
    '.loading',
    '.loader',
    '.spinner',
    '.nx-loader',
    '[class*="loading" i]',
    '[class*="loader" i]',
    '[class*="spinner" i]'
  ].join(',')).first().waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
}

async function isReportInterfaceVisible(page, timeout = 3000) {
  const reportType = page.locator('.nx-dropdown__container').first();

  return await reportType.isVisible({ timeout }).catch(() => false);
}

async function isRsaDashboardVisible(page, timeout = 3000) {
  return page.locator([
    'a[href="/report"]:has-text("Report")',
    'a[text-content="Report"]',
    'nx-header-navigation a:has-text("Report")',
    'button:has-text("Report")',
    '[role="button"]:has-text("Report")'
  ].join(',')).first().isVisible({ timeout }).catch(() => false);
}

async function isCaptchaChallengeVisible(page, timeout = 3000) {
  return page.locator([
    'iframe[src*="/recaptcha/api2/bframe"]',
    'iframe[src*="recaptcha/api2/bframe"]',
    'iframe[title*="challenge"]',
    'iframe[title*="Challenge"]'
  ].join(',')).first().isVisible({ timeout }).catch(() => false);
}

async function waitForCaptchaIfPresent(page, label) {
  if (!await isCaptchaChallengeVisible(page)) {
    return false;
  }

  logger.warn('RSA captcha challenge detected; waiting for manual solve', {
    label,
    timeoutMs: config.rsaCaptchaTimeoutMs
  });

  await page.waitForFunction(() => {
    const selectors = [
      'iframe[src*="/recaptcha/api2/bframe"]',
      'iframe[src*="recaptcha/api2/bframe"]',
      'iframe[title*="challenge"]',
      'iframe[title*="Challenge"]'
    ];
    const elements = selectors.flatMap(selector =>
      Array.from(document.querySelectorAll(selector))
    );

    return !elements.some(element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 10 &&
        rect.height > 10;
    });
  }, null, {
    timeout: config.rsaCaptchaTimeoutMs
  }).catch(() => {
    throw new Error('Timed out waiting for manual RSA captcha solve');
  });

  await humanPause('RSA captcha solved', 1);
  logger.info('RSA captcha challenge cleared; continuing automation', { label });
  return true;
}

async function waitForRsaDashboardOrReport(page) {
  logger.info('Waiting for RSA dashboard or report interface');
  await page.locator([
    '.nx-dropdown__container',
    'a[href="/report"]:has-text("Report")',
    'a[text-content="Report"]',
    'nx-header-navigation a:has-text("Report")',
    'a:has-text("Report")',
    'button:has-text("Report")',
    '[role="button"]:has-text("Report")'
  ].join(',')).first().waitFor({ state: 'visible', timeout: 60000 });
}

async function loginToRsaPortal(page) {
  logger.info('Opening RSA portal', { url: config.rsaPortalUrl });
  await page.goto(config.rsaPortalUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.loginTimeoutMs
  });

  if (await isReportInterfaceVisible(page) || await isRsaDashboardVisible(page)) {
    logger.info('RSA portal session restored; login skipped');
    return;
  }

  requireSecret('RSA_USER_ID', config.rsaUserId);
  requireSecret('RSA_PASSWORD', config.rsaPassword);

  logger.info('Filling RSA portal credentials');
  const userInput = await firstVisible(page, [
    'input[formcontrolname="username"]',
    '#nx-input-2',
    'nx-formfield[nxlabel="Username"] input',
    'input[name="username"]',
    'input[name="userName"]',
    'input[name="userid"]',
    'input[name="email"]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[placeholder*="user" i]',
    'input[placeholder*="email" i]',
    'input[type="text"]'
  ], 30000);
  await humanFill(userInput, config.rsaUserId, 'RSA username');

  const passwordInput = await firstVisible(page, [
    'input[formcontrolname="password"]',
    '#nx-input-3',
    'nx-formfield[nxlabel="Password"] input',
    'input[name="password"]',
    'input[id*="pass" i]',
    'input[placeholder*="pass" i]',
    'input[type="password"]'
  ], 30000);
  await humanFill(passwordInput, config.rsaPassword, 'RSA password');

  await clickRsaLoginButton(page);
  await waitForCaptchaIfPresent(page, 'after initial RSA login click');
  if (await handleConcurrentRsaSessionModal(page)) {
    logger.info('Retrying RSA login after concurrent session logout');
    await clickRsaLoginButton(page);
    await waitForCaptchaIfPresent(page, 'after RSA concurrent-session retry');
  }

  await waitForRsaDashboardOrReport(page);
  await waitForCaptchaIfPresent(page, 'before RSA dashboard/report wait completes');

  await saveSessionStateToPath(page.context(), config.rsaSessionStatePath);
  logger.info('RSA portal login success');
}

async function handleConcurrentRsaSessionModal(page) {
  const logoutEverywhereButton = await findLogoutEverywhereButton(page);

  if (!logoutEverywhereButton) {
    return false;
  }

  logger.warn('RSA concurrent session warning detected; logging out from everywhere');
  await humanPause('RSA concurrent session logout');
  await logoutEverywhereButton.scrollIntoViewIfNeeded().catch(() => {});
  await logoutEverywhereButton.click({ force: true });
  await page.locator([
    'nx-modal-container:has-text("Logout from everywhere")',
    '[role="dialog"]:has-text("Logout from everywhere")',
    'button:has-text("Logout from everywhere")'
  ].join(',')).first().waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  await waitForRsaDataIdle(page);
  return true;
}

async function findLogoutEverywhereButton(page, timeout = 20000) {
  const candidates = [
    page.getByRole('button', { name: /logout\s+from\s+everywhere/i }).first(),
    page.locator('button').filter({ hasText: /logout\s+from\s+everywhere/i }).first(),
    page.locator('[role="button"]').filter({ hasText: /logout\s+from\s+everywhere/i }).first(),
    page.locator('nx-modal-container button').filter({ hasText: /logout\s+from\s+everywhere/i }).first(),
    page.locator('nx-modal-container').getByText(/logout\s+from\s+everywhere/i).locator('xpath=ancestor::button[1]').first()
  ];

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        return candidate;
      }
    }
    await sleep(500);
  }

  return null;
}

async function clickRsaLoginButton(page) {
  const loginButton = await firstVisible(page, [
    'button.nx-button:has-text("Login")',
    'button[type="button"]:has-text("Login")',
    'button:has-text("Login")',
    'button:has-text("SIGN IN")',
    'button:has-text("Sign In")',
    'button:has-text("Submit")',
    '[role="button"]:has-text("Login")',
    'input[type="submit"]'
  ], 30000);

  await humanPause('RSA login click');
  await loginButton.click();
  await waitForRsaDataIdle(page);
  await waitForCaptchaIfPresent(page, 'RSA login action');
}

async function openRsaReportPage(page) {
  logger.info('Opening RSA report page through dashboard navigation');

  if (!await isReportInterfaceVisible(page) && !await isRsaDashboardVisible(page)) {
    await waitForRsaDashboardOrReport(page);
  }

  if (!await isReportInterfaceVisible(page)) {
    const reportLink = await firstVisible(page, [
      'a[href="/report"]:has-text("Report")',
      'a[text-content="Report"]',
      'nx-header-navigation a:has-text("Report")',
      'button:has-text("Report")',
      'a:has-text("Report")',
      '[role="button"]:has-text("Report")'
    ], 15000);
    await humanPause('RSA report navigation click');
    await reportLink.click();
    await waitForRsaDataIdle(page);
    await page.waitForURL(/\/report(?:$|[?#])/, { timeout: 30000 }).catch(() => {});
  }

  await page.locator('.nx-dropdown__container').first()
    .waitFor({ state: 'visible', timeout: 60000 });
  logger.info('RSA report interface loaded');
}

async function selectRsaReportType(page) {
  logger.info('Selecting RSA report type', { reportType: 'Policy Sale Detailed Report' });
  const dropdown = page.locator('.nx-dropdown__container').first();
  await dropdown.waitFor({ state: 'visible', timeout: 30000 });
  await humanPause('RSA report dropdown open');
  await dropdown.click();

  const optionText = /^Policy Sale Detailed Report$/;
  const option = page.locator([
    '.nx-dropdown__menu *',
    '.nx-dropdown__list *',
    '.nx-dropdown__item',
    '[role="option"]',
    'li'
  ].join(',')).filter({ hasText: optionText }).first();

  if (await option.isVisible({ timeout: 10000 }).catch(() => false)) {
    await humanPause('RSA report option select');
    await option.click();
  } else {
    await humanPause('RSA report option text select');
    await page.getByText('Policy Sale Detailed Report', { exact: true }).click();
  }

  await waitForRsaReportFiltersReady(page);
}

async function waitForRsaReportFiltersReady(page) {
  logger.info('Waiting for RSA report filters after report type selection');
  await waitForRsaDataIdle(page);
  if (config.rsaReportPageLoadDelayMs > 0) {
    await sleep(config.rsaReportPageLoadDelayMs);
  }

  await page.waitForFunction(() => {
    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(input => {
      const style = window.getComputedStyle(input);
      const rect = input.getBoundingClientRect();
      const fieldName = input.getAttribute('formcontrolname') || '';
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 10 &&
        rect.height > 10 &&
        !input.disabled &&
        input.type !== 'hidden' &&
        !['username', 'password'].includes(fieldName.toLowerCase());
    });

    return visibleInputs.length >= 2;
  }, null, { timeout: 60000 });

  const inputCount = await page.locator([
    'input:visible:not([formcontrolname="username"]):not([formcontrolname="password"]):not([type="hidden"])'
  ].join(',')).count().catch(() => 0);

  logger.info('RSA report filters ready', { visibleInputCount: inputCount });
}

async function firstVisibleRsaDateInput(page, candidates, fallbackIndex, label) {
  for (const selector of candidates) {
    const input = page.locator(selector).first();
    if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
      logger.info('Found RSA date input', { label, selector });
      return input;
    }
  }

  const visibleInputs = page.locator([
    'input:visible:not([formcontrolname="username"]):not([formcontrolname="password"]):not([type="hidden"])'
  ].join(','));
  const count = await visibleInputs.count();

  if (count > fallbackIndex) {
    logger.info('Using RSA visible input fallback for date field', {
      label,
      fallbackIndex,
      visibleInputCount: count
    });
    return visibleInputs.nth(fallbackIndex);
  }

  throw new Error(`Could not find RSA ${label} date input`);
}

async function fillRsaDateRange(page, range) {
  const startDate = formatDateForRsa(range.startDate);
  const endDate = formatDateForRsa(range.endDate);

  logger.info('Applying RSA report date range', {
    startDate,
    endDate
  });

  await waitForRsaReportFiltersReady(page);

  const endInput = await firstVisibleRsaDateInput(page, [
    '#nx-input-1',
    'nx-formfield:has-text("End Date") input',
    'nx-formfield:has-text("To Date") input',
    'nx-formfield:has-text("End") input',
    'input[placeholder*="End" i]',
    'input[placeholder*="To" i]'
  ], 1, 'end');
  await humanFill(endInput, endDate, 'RSA end date');

  const startInput = await firstVisibleRsaDateInput(page, [
    '#nx-input-0',
    'nx-formfield:has-text("Start Date") input',
    'nx-formfield:has-text("From Date") input',
    'nx-formfield:has-text("Start") input',
    'input[placeholder*="Start" i]',
    'input[placeholder*="From" i]'
  ], 0, 'start');
  await humanFill(startInput, startDate, 'RSA start date');
}

async function clickGetDetails(page) {
  const button = await firstVisible(page, [
    'button:has-text("GET DETAILS")',
    'button:has-text("Get Details")',
    '[role="button"]:has-text("GET DETAILS")',
    '[role="button"]:has-text("Get Details")'
  ], 30000);

  await humanPause('RSA get details click');
  await button.click();
  await waitForRsaDataIdle(page);
}

async function getRsaPagerState(page) {
  const pager = page.locator([
    '.pagination:visible',
    '.nx-pagination:visible',
    '.pager:visible',
    '[class*="pagination" i]:visible',
    '[class*="pager" i]:visible'
  ].join(',')).first();
  const visible = await pager.isVisible({ timeout: 2000 }).catch(() => false);

  if (!visible) {
    return { totalPages: 1, currentPage: 1, hasPager: false };
  }

  return pager.evaluate(pagerElement => {
    const pageControls = Array.from(pagerElement.querySelectorAll('button, a, [role="button"], li, span'));
    const numericValues = pageControls
      .map(element => Number.parseInt((element.textContent || '').trim(), 10))
      .filter(Number.isFinite);
    const active = pageControls.find(element =>
      element.getAttribute('aria-current') === 'page' ||
      element.classList.contains('active') ||
      element.classList.contains('selected') ||
      element.classList.contains('current')
    );
    const currentPage = Number.parseInt((active?.textContent || '').trim(), 10) || 1;
    const totalPages = numericValues.length ? Math.max(...numericValues) : 1;

    return {
      totalPages,
      currentPage,
      hasPager: true
    };
  });
}

async function clickRsaNextPage(page, nextPageNumber) {
  const nextButton = page.locator([
    'button:visible:has-text("Next")',
    'a:visible:has-text("Next")',
    '[role="button"]:visible:has-text("Next")',
    'button:visible[aria-label*="next" i]',
    'a:visible[aria-label*="next" i]',
    '[role="button"]:visible[aria-label*="next" i]'
  ].join(',')).first();

  if (await nextButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    const disabled = await nextButton.evaluate(element =>
      element.disabled === true ||
      element.classList.contains('disabled') ||
      element.classList.contains('nx-disabled') ||
      element.getAttribute('aria-disabled') === 'true'
    );

    if (!disabled) {
      await humanPause('RSA next page click');
      await nextButton.click();
      await waitForRsaDataIdle(page);
      return true;
    }
  }

  const pageNumberButton = page.locator('button, a, [role="button"]')
    .filter({ hasText: new RegExp(`^\\s*${nextPageNumber}\\s*$`) })
    .first();

  if (await pageNumberButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await humanPause('RSA page number click');
    await pageNumberButton.click();
    await waitForRsaDataIdle(page);
    return true;
  }

  return false;
}

async function exportCurrentRsaPageToFile(page, filePath) {
  const exportButton = await firstVisible(page, [
    'button:has-text("Export")',
    'a:has-text("Export")',
    '[role="button"]:has-text("Export")'
  ], 30000);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await humanPause('RSA export click');
  await exportButton.click();
  const download = await downloadPromise;
  await download.saveAs(filePath);
  await download.delete().catch(() => {});

  logger.info('RSA page exported', {
    filePath,
    suggestedFilename: download.suggestedFilename()
  });

  return filePath;
}

async function exportAllRsaPages(page, outputDir, filenameBase) {
  const { totalPages, currentPage, hasPager } = await getRsaPagerState(page);
  const files = [];

  logger.info('RSA pagination detected', {
    totalPages,
    currentPage,
    hasPager
  });

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const suffix = totalPages <= 1 ? '' : `_page_${pageNumber}`;
    const filePath = path.join(outputDir, `${filenameBase}${suffix}.xlsx`);
    await exportCurrentRsaPageToFile(page, filePath);
    files.push(filePath);

    if (pageNumber >= totalPages) {
      break;
    }

    const moved = await clickRsaNextPage(page, pageNumber + 1);
    if (!moved) {
      logger.warn('Could not move to next RSA page before expected last page', {
        pageNumber,
        totalPages
      });
      break;
    }

    if (config.rsaReportPageLoadDelayMs > 0) {
      logger.info('Waiting after RSA page change before next export', {
        delayMs: config.rsaReportPageLoadDelayMs
      });
      await sleep(config.rsaReportPageLoadDelayMs);
    }
  }

  return files;
}

async function hasNoRsaRecords(page) {
  return page.locator('text=/No Records found/i')
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);
}

export async function downloadRsaReport(page) {
  logger.info('RSA Report started');
  await loginToRsaPortal(page);
  await openRsaReportPage(page);
  await selectRsaReportType(page);

  const overrideRange = getReportDateOverrideRange();
  const range = overrideRange ?? (config.historicalBackfillEnabled
    ? {
        startDate: parseIsoLocalDate(config.historicalBackfillStartDate),
        endDate: new Date()
      }
    : getCurrentMonthToDateRange());
  if (config.historicalBackfillEnabled && !overrideRange) {
    range.startIso = toIsoDate(range.startDate);
    range.endIso = toIsoDate(range.endDate);
  }
  const chunks = (config.historicalBackfillEnabled || overrideRange)
    ? getThirtyDayChunks(range.startDate, range.endDate)
    : [range];
  const exportDir = buildRunDir();
  const exportFiles = [];

  logger.info('RSA Report date chunks prepared', {
    mode: config.historicalBackfillEnabled ? 'historical-backfill' : 'current-month',
    startDate: range.startIso,
    endDate: range.endIso,
    chunkCount: chunks.length,
    exportDir
  });

  for (const [index, chunk] of chunks.entries()) {
    await fillRsaDateRange(page, chunk);

    logger.info('Requesting RSA report details for chunk', {
      chunk: `${index + 1}/${chunks.length}`,
      startDate: chunk.startIso,
      endDate: chunk.endIso
    });
    await clickGetDetails(page);
    await waitForCaptchaIfPresent(page, 'after RSA get details');
    if (config.rsaReportPostSearchDelayMs > 0) {
      logger.info('Waiting for RSA asynchronous table data', {
        delayMs: config.rsaReportPostSearchDelayMs
      });
      await sleep(config.rsaReportPostSearchDelayMs);
    }

    if (await hasNoRsaRecords(page)) {
      logger.info('RSA report chunk has no records; skipping export', {
        chunk: `${index + 1}/${chunks.length}`,
        startDate: chunk.startIso,
        endDate: chunk.endIso
      });
      continue;
    }

    const chunkFiles = await exportAllRsaPages(
      page,
      exportDir,
      `rsa_report_${chunk.startIso}_to_${chunk.endIso}`
    );
    exportFiles.push(...chunkFiles);
  }

  if (!exportFiles.length) {
    await cleanupReportExportDir(exportDir);

    logger.info('RSA Report finished with no records to export', {
      sheetName: config.rsaReportSheetName,
      chunkCount: chunks.length,
      pageCount: 0,
      rowCount: 0
    });

    return {
      name: 'RSA Report',
      sheetName: config.rsaReportSheetName,
      dbResult: {
        action: 'no-records',
        rowCount: 0,
        headerCount: 0,
        chunkCount: chunks.length,
        pageCount: 0,
        addedRowCount: 0,
        duplicateRowCount: 0
      },
      dateRange: range
    };
  }

  const merged = await mergeExcelFiles(exportFiles);
  const dbResult = await saveReportSheetToSupabase({
    brand: 'kia',
    sheetName: config.rsaReportSheetName,
    headers: merged.headers,
    rows: merged.rows
  });

  await cleanupReportExportDir(exportDir);

  logger.info('RSA Report finished', {
    sheetName: config.rsaReportSheetName,
    dbAction: dbResult.action,
    rowCount: merged.rows.length,
    headerCount: merged.headers.length,
    chunkCount: chunks.length,
    pageCount: exportFiles.length,
    addedRowCount: dbResult.addedRowCount,
    duplicateRowCount: dbResult.duplicateRowCount
  });

  return {
    name: 'RSA Report',
    sheetName: config.rsaReportSheetName,
    dbResult: {
      ...dbResult,
      rowCount: merged.rows.length,
      headerCount: merged.headers.length,
      chunkCount: chunks.length,
      pageCount: exportFiles.length
    },
    dateRange: range
  };
}
