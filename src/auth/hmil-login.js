import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { config, requireSecret } from '../config.js';
import { createGdmsAccountProfile } from '../accounts/gdms-account-profile.js';
import { getOtp } from '../otp/index.js';
import { clickAndWait, saveSessionStateToPath } from '../playwright/browser.js';
import { selectors } from '../playwright/selectors.js';
import { withDirectoryLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

const HMIL_USER_SELECTORS = [
  '#usrId',
  '#userId',
  '#loginId',
  'input[name="usrId"]',
  'input[name="userId"]',
  'input[name="USER_ID"]',
  'input[name="loginId"]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[id*="login" i]',
  'input[placeholder*="User" i]',
  ...selectors.userId
];

const HMIL_PASSWORD_SELECTORS = [
  '#usrPswdNo',
  '#password',
  '#pwd',
  '#passwd',
  'input[name="usrPswdNo"]',
  'input[type="password"]',
  'input[name="password"]',
  'input[name*="pass" i]',
  'input[name*="pwd" i]',
  'input[id*="pass" i]',
  'input[id*="pwd" i]',
  ...selectors.password
];

const HMIL_SEND_OTP_SELECTORS = [
  '#btnGenerateOtp',
  '#btnSendOtp',
  '#btnSendOTP',
  'button:has-text("Send OTP")',
  'input[type="button"][value*="Send OTP" i]',
  'a:has-text("Send OTP")',
  ...selectors.sendOtp
];

const HMIL_OTP_SELECTORS = [
  '#otpEnter',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[placeholder*="OTP" i]',
  ...selectors.otp
];

const HMIL_SUBMIT_SELECTORS = [
  '#btnLoginClickGdmsNew',
  '#btnLogin',
  '#btnSubmit',
  'button:has-text("Login")',
  'button:has-text("Submit")',
  'input[type="button"][value*="Login" i]',
  'input[type="button"][value*="Submit" i]',
  'input[type="submit"]',
  ...selectors.submit
];

async function firstVisibleHmil(page, candidates, { timeout = 10000, label = 'HMIL control', perSelectorTimeout = 300 } = {}) {
  const startedAt = Date.now();

  for (const selector of candidates) {
    const remainingMs = timeout - (Date.now() - startedAt);
    if (remainingMs <= 0) break;

    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({
        state: 'visible',
        timeout: Math.min(remainingMs, perSelectorTimeout)
      });
      logger.info('Found HMIL login control', { label, selector });
      return locator;
    } catch {
      // Try the next selector without burning the full login timeout on each fallback.
    }
  }

  throw new Error(`Could not find visible ${label} from selectors: ${candidates.join(', ')}`);
}

async function ensureDir(fileOrDirPath) {
  const dir = path.extname(fileOrDirPath) ? path.dirname(fileOrDirPath) : fileOrDirPath;
  await fs.mkdir(dir, { recursive: true });
}

async function stateExists(statePath) {
  return fs.access(statePath).then(() => true).catch(() => false);
}

function loginPageUrl(account) {
  if (/selectLoginAction\.json/i.test(account.loginUrl)) {
    return account.loginUrl.replace(/selectLoginAction\.json/i, 'selectLoginMain.dms');
  }

  return account.loginUrl;
}

async function createHmilBrowserSession(account) {
  await ensureDir(account.sessionStatePath);
  await ensureDir(account.downloadDir);

  const savedStorageStateExists = await stateExists(account.sessionStatePath);
  const hasStorageState = savedStorageStateExists && !account.forceLogin;
  const browser = await chromium.launch({
    headless: account.headless ?? config.headless,
    slowMo: config.slowMoMs,
    downloadsPath: account.downloadDir
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: hasStorageState ? account.sessionStatePath : undefined
  });
  context.setDefaultTimeout(config.playwrightActionTimeoutMs);
  context.setDefaultNavigationTimeout(config.playwrightNavigationTimeoutMs);

  const page = await context.newPage();
  if (hasStorageState) {
    logger.info(`Loaded saved ${account.logPrefix} Playwright storage state`, {
      path: account.sessionStatePath
    });
  } else if (savedStorageStateExists && account.forceLogin) {
    logger.info(`${account.logPrefix} force login enabled; saved storage state ignored for clean login`, {
      path: account.sessionStatePath
    });
  }

  return {
    browser,
    context,
    page,
    hasStorageState,
    savedStorageStateExists,
    close: () => browser.close()
  };
}

async function hasExistingHmilSession(page, account) {
  try {
    logger.info(`Checking saved ${account.logPrefix} DMS session`, { url: account.homeUrl });
    await page.goto(account.homeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(config.loginTimeoutMs, account.sessionCheckTimeoutMs)
    });

    const menuVisible = await page.locator('#gnb, li[class*="nav_"], a.menuItem').first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (menuVisible) {
      logger.info(`${account.logPrefix} session restored; OTP login skipped`);
      return true;
    }

    const loginVisible = await page.locator(HMIL_PASSWORD_SELECTORS.join(',')).first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (loginVisible) {
      logger.warn(`Saved ${account.logPrefix} session is expired or not accepted`);
      return false;
    }

    return false;
  } catch (error) {
    logger.warn(`Could not verify saved ${account.logPrefix} session; full login will be attempted`, {
      message: error.message
    });
    return false;
  }
}

async function performOtpLogin(page, context, account) {
  const url = loginPageUrl(account);
  logger.info(`Opening ${account.logPrefix} DMS login page`, { url });
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: config.loginTimeoutMs
  });

  if (config.pageReadyDelayMs > 0) {
    logger.info(`${account.logPrefix} login page loaded; waiting briefly before credentials`, {
      delayMs: config.pageReadyDelayMs
    });
    await sleep(config.pageReadyDelayMs);
  }

  const userIdInput = await firstVisibleHmil(page, HMIL_USER_SELECTORS, {
    timeout: 10000,
    label: 'user id'
  });
  await userIdInput.fill(account.userId);

  const passwordInput = await firstVisibleHmil(page, HMIL_PASSWORD_SELECTORS, {
    timeout: 10000,
    label: 'password'
  });
  await passwordInput.fill(account.password);

  logger.info(`Requesting ${account.logPrefix} OTP`);
  const sendOtpButton = await firstVisibleHmil(page, HMIL_SEND_OTP_SELECTORS, {
    timeout: 10000,
    label: 'send OTP button'
  });
  const otpRequestedAt = new Date();
  await sendOtpButton.click();

  const otpInput = await firstVisibleHmil(page, HMIL_OTP_SELECTORS, {
    timeout: config.otpTimeoutMs,
    label: 'OTP input',
    perSelectorTimeout: config.otpTimeoutMs
  });
  logger.info(`${account.logPrefix} OTP input is ready; waiting for OTP provider`, {
    provider: config.otpProvider,
    purpose: account.otpPurpose
  });
  const otp = await getOtp({ notBefore: otpRequestedAt, purpose: account.otpPurpose });
  await otpInput.fill(otp);

  logger.info(`Submitting ${account.logPrefix} OTP`);
  const submitButton = await firstVisibleHmil(page, HMIL_SUBMIT_SELECTORS, {
    timeout: config.loginTimeoutMs,
    label: 'login button',
    perSelectorTimeout: 3000
  });
  await clickAndWait(page, submitButton, config.loginTimeoutMs);

  const menuVisible = await page.locator('#gnb, li[class*="nav_"], a.menuItem').first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true)
    .catch(() => false);

  if (!menuVisible || /selectLoginAction\.json/i.test(page.url())) {
    logger.warn(`${account.logPrefix} home menu not visible after OTP submit; opening home page directly`, {
      currentUrl: page.url(),
      homeUrl: account.homeUrl
    });
    await page.goto(account.homeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.loginTimeoutMs
    });
    await page.locator('#gnb, li[class*="nav_"], a.menuItem').first()
      .waitFor({ state: 'visible', timeout: config.loginTimeoutMs });
  }

  await saveSessionStateToPath(context, account.sessionStatePath);
}

export async function loginToHmilDms(account = createGdmsAccountProfile('hmil')) {
  requireSecret(account.userIdEnvName, account.userId);
  requireSecret(account.passwordEnvName, account.password);
  logger.info(`${account.logPrefix} DMS login started`);

  const session = await createHmilBrowserSession(account);
  const { browser, context, page, hasStorageState } = session;

  try {
    if (hasStorageState && await hasExistingHmilSession(page, account)) {
      return { browser, context, page, reusedSession: true, close: session.close };
    }

    await withDirectoryLock(
      config.gdmsOtpLockDir,
      () => performOtpLogin(page, context, account),
      {
        label: `${account.logPrefix} GDMS OTP login`,
        timeoutMs: config.gdmsOtpLockTimeoutMs,
        staleMs: config.gdmsOtpLockStaleMs
      }
    );
    logger.info(`${account.logPrefix} DMS login success`);

    return { browser, context, page, reusedSession: false, close: session.close };
  } catch (error) {
    const screenshotPath = path.join(config.rootDir, `${account.id}-login-error.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    logger.error(`${account.logPrefix} DMS login failure`, error);
    logger.info(`Saved ${account.logPrefix} failure screenshot`, { path: screenshotPath });
    await browser.close();
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const session = await loginToHmilDms();
  await session.close();
}
