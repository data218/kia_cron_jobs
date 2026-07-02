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

function sessionMetaPath(statePath) {
  return `${statePath}.meta.json`;
}

async function readSessionMeta(statePath) {
  try {
    return JSON.parse(await fs.readFile(sessionMetaPath(statePath), 'utf8'));
  } catch {
    return null;
  }
}

async function writeSessionMeta(statePath, account) {
  await ensureDir(statePath);
  await fs.writeFile(sessionMetaPath(statePath), JSON.stringify({
    userId: String(account.userId || '').trim(),
    accountId: account.id,
    savedAt: new Date().toISOString()
  }, null, 2));
}

async function deleteSessionArtifacts(statePath) {
  await fs.unlink(statePath).catch(() => {});
  await fs.unlink(sessionMetaPath(statePath)).catch(() => {});
}

async function migrateLegacySessionArtifacts(account) {
  const targetPath = account.sessionStatePath;
  const targetMetaPath = sessionMetaPath(targetPath);
  const legacyPaths = [...new Set(
    (account.legacySessionStatePaths || [])
      .map(filePath => String(filePath || '').trim())
      .filter(Boolean)
      .filter(filePath => path.resolve(filePath) !== path.resolve(targetPath))
  )];

  if (!legacyPaths.length || await stateExists(targetPath)) {
    return;
  }

  for (const legacyPath of legacyPaths) {
    if (!(await stateExists(legacyPath))) {
      continue;
    }

    await ensureDir(targetPath);
    await fs.copyFile(legacyPath, targetPath);

    const legacyMetaPath = sessionMetaPath(legacyPath);
    if (await stateExists(legacyMetaPath)) {
      await fs.copyFile(legacyMetaPath, targetMetaPath).catch(() => {});
    }
    await writeSessionMeta(targetPath, account);

    logger.info(`Migrated legacy ${account.logPrefix} session cache to user-scoped path`, {
      userId: account.userId,
      legacyPath,
      targetPath
    });
    return;
  }
}

async function sessionMetaMatchesAccount(statePath, account) {
  const meta = await readSessionMeta(statePath);
  if (!meta?.userId) {
    return false;
  }

  return String(meta.userId).trim().toUpperCase() === String(account.userId || '').trim().toUpperCase();
}

function normalizeHmilBaseUrl(url) {
  const cleaned = String(url || 'https://ndms.hmil.net').trim().replace(/\/+$/, '');
  return cleaned.replace(/\/cmm\/.*$/i, '');
}

function loginPageUrl(account) {
  const url = account.loginUrl || 'https://ndms.hmil.net';

  if (/selectLoginAction\.json/i.test(url)) {
    return url.replace(/selectLoginAction\.json/i, 'selectLoginMain.dms');
  }

  if (/selectLoginMain\.dms/i.test(url)) {
    return url;
  }

  const base = normalizeHmilBaseUrl(url);
  if (/ndms\.hmil\.net$/i.test(base)) {
    return `${base}/cmm/cmmi/selectLoginMain.dms`;
  }

  return url;
}

function homePageUrl(account) {
  const url = account.homeUrl || account.loginUrl || 'https://ndms.hmil.net';

  if (/selectHome\.dms/i.test(url)) {
    return url;
  }

  const base = normalizeHmilBaseUrl(url);
  if (/ndms\.hmil\.net$/i.test(base)) {
    return `${base}/cmm/cmmd/selectHome.dms`;
  }

  return url;
}

async function createHmilBrowserSession(account) {
  await ensureDir(account.sessionStatePath);
  await ensureDir(account.downloadDir);
  await migrateLegacySessionArtifacts(account);

  if (account.forceLogin) {
    await deleteSessionArtifacts(account.sessionStatePath);
  }

  const savedStorageStateExists = await stateExists(account.sessionStatePath);
  const metaMatches = savedStorageStateExists
    ? await sessionMetaMatchesAccount(account.sessionStatePath, account)
    : false;

  if (savedStorageStateExists && !metaMatches) {
    logger.warn(`Saved ${account.logPrefix} session metadata missing or wrong user; ignoring cached cookies`, {
      path: account.sessionStatePath,
      expectedUserId: account.userId
    });
    await deleteSessionArtifacts(account.sessionStatePath);
  }

  const canReuseStorageState = savedStorageStateExists && metaMatches && !account.forceLogin;
  const browser = await chromium.launch({
    headless: account.headless ?? config.headless,
    slowMo: config.slowMoMs,
    downloadsPath: account.downloadDir
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: canReuseStorageState ? account.sessionStatePath : undefined
  });
  context.setDefaultTimeout(config.playwrightActionTimeoutMs);
  context.setDefaultNavigationTimeout(config.playwrightNavigationTimeoutMs);

  const page = await context.newPage();
  if (canReuseStorageState) {
    logger.info(`Loaded saved ${account.logPrefix} Playwright storage state`, {
      path: account.sessionStatePath,
      userId: account.userId
    });
  } else if (savedStorageStateExists && account.forceLogin) {
    logger.info(`${account.logPrefix} force login enabled; saved storage state ignored for clean OTP login`, {
      path: account.sessionStatePath,
      userId: account.userId
    });
  }

  return {
    browser,
    context,
    page,
    hasStorageState: canReuseStorageState,
    savedStorageStateExists,
    close: () => browser.close()
  };
}

async function verifyRestoredSessionUser(page, account) {
  const expectedUserId = String(account.userId || '').trim().toUpperCase();
  if (!expectedUserId) {
    return true;
  }

  let bodyText = '';
  try {
    bodyText = (await page.locator('body').innerText({ timeout: 5000 })).toUpperCase();
  } catch {
    if (account.id?.startsWith('am-platinum')) {
      logger.warn(`Could not read ${account.logPrefix} home page; forcing fresh OTP login`);
      return false;
    }
    return true;
  }

  if (bodyText.includes(expectedUserId)) {
    return true;
  }

  const historicalUserId = String(config.amPlatinumHistoricalUserId || 'MIS12345').trim().toUpperCase();
  const currentUserId = String(config.amPlatinumUserId || 'MIS1988').trim().toUpperCase();

  if (account.id === 'am-platinum' && bodyText.includes(historicalUserId) && !bodyText.includes(currentUserId)) {
    logger.warn(`Saved ${account.logPrefix} session belongs to ${historicalUserId}, not ${expectedUserId}; forcing fresh OTP login`);
    return false;
  }

  if (account.id === 'am-platinum-historical' && bodyText.includes(currentUserId) && !bodyText.includes(historicalUserId)) {
    logger.warn(`Saved ${account.logPrefix} session belongs to ${currentUserId}, not ${expectedUserId}; forcing fresh OTP login`);
    return false;
  }

  if (account.id?.startsWith('am-platinum')) {
    logger.info(`Could not confirm ${expectedUserId} from restored ${account.logPrefix} page text, but no other Platinum login was detected; reusing saved session`, {
      expectedUserId
    });
    return true;
  }

  return true;
}

async function hasExistingHmilSession(page, account) {
  const url = homePageUrl(account);
  const sessionCheckTimeoutMs = Math.min(config.loginTimeoutMs, account.sessionCheckTimeoutMs);
  const maxAttempts = account.id?.startsWith('am-platinum') ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      logger.info(`Checking saved ${account.logPrefix} DMS session`, {
        url,
        attempt,
        maxAttempts,
        timeoutMs: sessionCheckTimeoutMs
      });
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: sessionCheckTimeoutMs
      });

      const menuVisible = await page.locator('#gnb, li[class*="nav_"], a.menuItem').first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (menuVisible) {
        if (!(await verifyRestoredSessionUser(page, account))) {
          return false;
        }

        logger.info(`${account.logPrefix} session restored; OTP login skipped`, {
          userId: account.userId
        });
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
      const canRetry = attempt < maxAttempts && /timeout/i.test(String(error?.message || ''));
      if (canRetry) {
        logger.warn(`Saved ${account.logPrefix} session check timed out; retrying before OTP fallback`, {
          attempt,
          maxAttempts,
          message: error.message
        });
        await sleep(1500);
        continue;
      }

      logger.warn(`Could not verify saved ${account.logPrefix} session; full login will be attempted`, {
        attempt,
        maxAttempts,
        message: error.message
      });
      return false;
    }
  }

  return false;
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
  await userIdInput.fill('');
  await userIdInput.fill(account.userId);
  logger.info(`${account.logPrefix} login user id set`, { userId: account.userId });

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
    provider: account.otpProvider ?? config.otpProvider,
    purpose: account.otpPurpose
  });
  const otp = await getOtp({
    notBefore: otpRequestedAt,
    purpose: account.otpPurpose,
    provider: account.otpProvider
  });
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
    const resolvedHomeUrl = homePageUrl(account);
    logger.warn(`${account.logPrefix} home menu not visible after OTP submit; opening home page directly`, {
      currentUrl: page.url(),
      homeUrl: resolvedHomeUrl
    });
    await page.goto(resolvedHomeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.loginTimeoutMs
    });
    await page.locator('#gnb, li[class*="nav_"], a.menuItem').first()
      .waitFor({ state: 'visible', timeout: config.loginTimeoutMs });
  }

  await saveSessionStateToPath(context, account.sessionStatePath);
  await writeSessionMeta(account.sessionStatePath, account);
  logger.info(`${account.logPrefix} session saved for user`, {
    userId: account.userId,
    path: account.sessionStatePath
  });
}

async function withGdmsOtpLock(account, fn) {
  if (!config.gdmsOtpLockEnabled) {
    logger.info(`${account.logPrefix} GDMS OTP lock disabled; proceeding without cross-process lock`);
    return fn();
  }

  return withDirectoryLock(
    config.gdmsOtpLockDir,
    fn,
    {
      label: `${account.logPrefix} GDMS OTP login`,
      timeoutMs: config.gdmsOtpLockTimeoutMs,
      staleMs: config.gdmsOtpLockStaleMs
    }
  );
}

export async function loginToHmilDms(account = createGdmsAccountProfile('hmil')) {
  requireSecret(account.userIdEnvName, account.userId);
  requireSecret(account.passwordEnvName, account.password);
  logger.info(`${account.logPrefix} DMS login started`);

  return withGdmsOtpLock(account, async () => {
    const session = await createHmilBrowserSession(account);
    const { browser, context, page, hasStorageState } = session;

    try {
      if (hasStorageState && await hasExistingHmilSession(page, account)) {
        logger.info(`${account.logPrefix} DMS login success`, { userId: account.userId, reusedSession: true });
        return { browser, context, page, reusedSession: true, close: session.close };
      }

      if (hasStorageState) {
        await deleteSessionArtifacts(account.sessionStatePath);
      }

      await performOtpLogin(page, context, account);
      logger.info(`${account.logPrefix} DMS login success`, { userId: account.userId, reusedSession: false });
      return { browser, context, page, reusedSession: false, close: session.close };
    } catch (error) {
      const screenshotPath = path.join(config.rootDir, `${account.id}-login-error.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      logger.error(`${account.logPrefix} DMS login failure`, error);
      logger.info(`Saved ${account.logPrefix} failure screenshot`, { path: screenshotPath });
      await browser.close();
      throw error;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const session = await loginToHmilDms();
  await session.close();
}
