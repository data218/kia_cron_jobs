import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config, requireSecret } from '../config.js';
import { saveSessionStateToPath } from '../playwright/browser.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

// Element ids come from the portal's own Scripts/Login.js (SubmitsEncry).
const SELECTORS = {
  userId: '#txtUserName',
  password: '#txtPassword',
  captchaInput: '#txtcaptcha',
  captchaAnswer: '#hdnCaptcha',
  captchaEnabled: '#hdnCaptchaEnabled',
  captchaImage: '#imgCaptcha',
  loginButton: '#btnlogin',
  messageModal: '#PageSubmitMsg',
  messageText: '#AlertMessageContact',
  otpModal: '#divEnterOTP',
  otpInput: '#OtpDigit',
  otpSubmit: '#btnPopupOk'
};

async function ensureDir(fileOrDirPath) {
  const dir = path.extname(fileOrDirPath) ? path.dirname(fileOrDirPath) : fileOrDirPath;
  await fs.mkdir(dir, { recursive: true });
}

function resolveOptions(options = {}) {
  const captchaMode = (options.captchaMode ?? config.hiibCaptchaMode) === 'manual' ? 'manual' : 'auto';

  // A human cannot read the captcha out of a headless browser.
  let headless = options.headless ?? config.hiibHeadless;
  if (captchaMode === 'manual' && headless) {
    logger.warn('HIIB manual captcha mode requires a visible browser; overriding headless to false');
    headless = false;
  }

  const account = options.account ?? null;

  return {
    account,
    accountId: account?.id ?? 'hiib',
    // Credentials come from the account profile when one is supplied, so a second
    // portal login (e.g. Platinum/N5211) never picks up the default one.
    userId: options.userId ?? account?.userId ?? config.hiibUserId,
    password: options.password ?? account?.password ?? config.hiibPassword,
    captchaMode,
    headless,
    manualCaptchaWaitMs: options.manualCaptchaWaitMs ?? config.hiibManualCaptchaWaitMs,
    manualCaptchaPollMs: options.manualCaptchaPollMs ?? config.hiibManualCaptchaPollMs,
    forceLogin: options.forceLogin ?? config.hiibForceLogin,
    loginRetries: options.loginRetries ?? config.hiibLoginRetries,
    sessionStatePath: options.sessionStatePath ?? account?.sessionStatePath ?? config.hiibSessionStatePath,
    downloadDir: options.downloadDir ?? account?.downloadDir ?? config.hiibDownloadDir
  };
}

async function createHiibBrowserSession(settings) {
  await ensureDir(settings.sessionStatePath);
  await ensureDir(settings.downloadDir);

  const hasStorageState = settings.forceLogin
    ? false
    : await fs.access(settings.sessionStatePath).then(() => true).catch(() => false);

  const launchOptions = {
    headless: settings.headless,
    slowMo: config.slowMoMs,
    downloadsPath: settings.downloadDir
  };
  if (config.playwrightBrowserChannel) {
    launchOptions.channel = config.playwrightBrowserChannel;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    acceptDownloads: true,
    // Wide enough that the admin template keeps the side navigation expanded.
    viewport: { width: 1600, height: 900 },
    storageState: hasStorageState ? settings.sessionStatePath : undefined
  });
  context.setDefaultTimeout(config.playwrightActionTimeoutMs);
  context.setDefaultNavigationTimeout(config.playwrightNavigationTimeoutMs);
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    hasStorageState,
    close: () => browser.close()
  };
}

function isLoginUrl(url) {
  const normalized = String(url || '').toLowerCase();
  if (!normalized) return true;
  if (normalized.includes('/login')) return true;

  // The portal bounces unauthenticated deep links back to the site root.
  try {
    const { pathname } = new URL(normalized);
    return pathname === '/' || pathname === '';
  } catch {
    return false;
  }
}

async function loginFormIsPresent(page) {
  return page.locator(SELECTORS.userId).first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
}

/**
 * Confirms a restored storage state is still authenticated by opening a page
 * that requires a session and checking we were not bounced back to the login form.
 */
async function hasLiveSession(page, targetUrl) {
  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.hiibSessionCheckTimeoutMs
    });
  } catch (error) {
    logger.warn('HIIB session probe navigation failed', { error: error.message });
    return false;
  }

  await page.waitForLoadState('networkidle', { timeout: config.hiibSessionCheckTimeoutMs }).catch(() => {});

  if (await loginFormIsPresent(page)) return false;
  return !isLoginUrl(page.url());
}

/**
 * The portal validates the captcha entirely in the browser: Login.js compares the
 * typed value against #hdnCaptcha, a hidden field rendered alongside the image.
 * Reading that field is how we solve it without OCR.
 */
async function readCaptchaAnswer(page) {
  return page.evaluate(id => document.getElementById(id)?.value ?? '', SELECTORS.captchaAnswer.slice(1))
    .catch(() => '');
}

async function captchaIsEnabled(page) {
  const raw = await page
    .evaluate(id => document.getElementById(id)?.value ?? '', SELECTORS.captchaEnabled.slice(1))
    .catch(() => 'True');
  return String(raw).trim().toLowerCase() === 'true';
}

async function solveCaptchaAutomatically(page) {
  const answer = await readCaptchaAnswer(page);
  if (!answer) {
    throw new Error('Could not read the HIIB captcha value from the login page');
  }

  await page.fill(SELECTORS.captchaInput, answer);
  logger.info('HIIB captcha solved automatically', { length: answer.length });
  return answer;
}

/**
 * Manual mode: leave the captcha box empty and let a human fill it in the visible
 * browser. Resolves as soon as they have typed something (plus a short settle
 * window so we do not submit a half-typed value), or if they click Login themselves.
 */
async function waitForManualCaptcha(page, settings) {
  const deadline = Date.now() + settings.manualCaptchaWaitMs;
  const waitSeconds = Math.round(settings.manualCaptchaWaitMs / 1000);

  logger.info(
    `HIIB captcha is in MANUAL mode - type the captcha in the open browser window. ` +
    `Waiting up to ${waitSeconds}s, then logging in automatically.`,
    { waitSeconds }
  );

  while (Date.now() < deadline) {
    // The human may have pressed Login themselves.
    if (!isLoginUrl(page.url())) {
      logger.info('HIIB login was submitted manually in the browser');
      return { submittedByHuman: true, value: null };
    }

    const typed = await page.inputValue(SELECTORS.captchaInput).catch(() => '');
    if (typed.trim()) {
      // Give them a moment to finish the remaining characters.
      let stable = typed.trim();
      for (let i = 0; i < 3; i += 1) {
        await sleep(700);
        const next = (await page.inputValue(SELECTORS.captchaInput).catch(() => stable)).trim();
        if (next === stable) break;
        stable = next;
      }

      logger.info('HIIB captcha entered manually; submitting login', { length: stable.length });
      return { submittedByHuman: false, value: stable };
    }

    await sleep(settings.manualCaptchaPollMs);
  }

  throw new Error(
    `No captcha was entered within ${waitSeconds}s. ` +
    `Set HIIB_CAPTCHA_MODE=auto to solve it automatically, or raise HIIB_MANUAL_CAPTCHA_WAIT_MS.`
  );
}

/**
 * Retrying a rejected credential just burns attempts against the portal's lockout
 * counter, so only transient/captcha failures are worth a second try.
 */
function isTerminalLoginMessage(message) {
  return /invalid\s+(user|username|user name|password|login)|incorrect\s+password|locked|blocked|disabled|deactivat|suspend|expired|not\s+registered|does\s+not\s+exist/i
    .test(String(message || ''));
}

async function readVisibleMessage(page) {
  const modal = page.locator(SELECTORS.messageModal).first();
  const visible = await modal.isVisible({ timeout: 500 }).catch(() => false);
  if (!visible) return '';

  const text = await page.locator(SELECTORS.messageText).first().innerText().catch(() => '');
  return text.trim();
}

async function dismissMessageModal(page) {
  await page.evaluate(id => {
    const win = window;
    const jquery = win.jQuery ?? win.$;
    if (jquery) jquery('#' + id).modal('hide');
  }, SELECTORS.messageModal.slice(1)).catch(() => {});
  await sleep(400);
}

/**
 * Login.js encrypts the client IP into the login payload; the value is filled in
 * asynchronously from an external lookup. Give it a brief chance to arrive so the
 * payload matches what a real browser session would send.
 */
async function waitForClientMetadata(page, timeoutMs = 5000) {
  await page.waitForFunction(
    () => typeof window.clientIP === 'string' && window.clientIP.length > 0,
    undefined,
    { timeout: timeoutMs }
  ).catch(() => {
    logger.warn('HIIB client IP lookup did not complete in time; submitting login anyway');
  });
}

/**
 * Waits for whichever branch of Login.js fires after the credentials POST:
 * dashboard redirect, OTP modal, forced password reset, or an error modal.
 */
async function waitForLoginOutcome(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const url = page.url();

    if (/\/login\/changepassword/i.test(url)) {
      return { outcome: 'password-reset-required', url };
    }
    if (!isLoginUrl(url)) {
      return { outcome: 'success', url };
    }

    const otpVisible = await page.locator(SELECTORS.otpModal).first()
      .isVisible({ timeout: 200 }).catch(() => false);
    if (otpVisible) {
      return { outcome: 'otp-required', url };
    }

    const message = await readVisibleMessage(page);
    if (message) {
      return { outcome: 'error', message, url };
    }

    await sleep(500);
  }

  return { outcome: 'timeout', url: page.url() };
}

async function handleOtpChallenge(page, settings) {
  logger.warn('HIIB portal requested a login OTP', {
    provider: config.hiibOtpProvider,
    waitMs: config.hiibOtpWaitMs
  });

  const deadline = Date.now() + config.hiibOtpWaitMs;
  const waitSeconds = Math.round(config.hiibOtpWaitMs / 1000);

  if (settings.headless) {
    throw new Error(
      'HIIB login requires an OTP but the browser is headless. ' +
      'Re-run with HIIB_HEADLESS=false so the OTP can be entered.'
    );
  }

  logger.info(`Enter the OTP in the open browser window within ${waitSeconds}s`, { waitSeconds });

  while (Date.now() < deadline) {
    if (!isLoginUrl(page.url())) {
      return true;
    }

    const otpVisible = await page.locator(SELECTORS.otpModal).first()
      .isVisible({ timeout: 200 }).catch(() => false);
    if (!otpVisible) {
      // Modal closed without navigating - let the outer loop re-evaluate.
      return !isLoginUrl(page.url());
    }

    await sleep(1000);
  }

  throw new Error(`HIIB login OTP was not completed within ${waitSeconds}s`);
}

async function attemptLogin(page, settings, attempt) {
  await page.goto(config.hiibLoginUrl, { waitUntil: 'domcontentloaded' });
  await page.locator(SELECTORS.userId).first().waitFor({ state: 'visible', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  logger.info('HIIB login page loaded', {
    attempt,
    url: page.url(),
    captchaMode: settings.captchaMode
  });

  await page.fill(SELECTORS.userId, settings.userId);
  await page.fill(SELECTORS.password, settings.password);

  const needsCaptcha = await captchaIsEnabled(page);
  let submittedByHuman = false;

  if (!needsCaptcha) {
    logger.info('HIIB captcha is disabled for this session');
  } else if (settings.captchaMode === 'manual') {
    const manual = await waitForManualCaptcha(page, settings);
    submittedByHuman = manual.submittedByHuman;
  } else {
    await solveCaptchaAutomatically(page);
  }

  if (!submittedByHuman) {
    await waitForClientMetadata(page);
    logger.info('Submitting HIIB login', {
      attempt,
      account: settings.accountId,
      userId: settings.userId
    });
    await page.click(SELECTORS.loginButton);
  }

  let result = await waitForLoginOutcome(page);

  if (result.outcome === 'otp-required') {
    const otpCompleted = await handleOtpChallenge(page, settings);
    result = otpCompleted
      ? await waitForLoginOutcome(page)
      : { outcome: 'error', message: 'OTP challenge was not completed', url: page.url() };
  }

  return result;
}

/**
 * Logs into the HIIB (ha.hiib.in) insurance broker portal.
 *
 * Returns the same session shape as the other portal login modules:
 *   { browser, context, page, reusedSession, close }
 * The caller owns the session and must call close(). On failure this module
 * closes the browser itself and rethrows.
 */
export async function loginToHiibPortal(options = {}) {
  const settings = resolveOptions(options);
  requireSecret('HIIB_USER_ID', settings.userId);
  requireSecret('HIIB_PASSWORD', settings.password);
  const session = await createHiibBrowserSession(settings);
  const { browser, context, page } = session;

  try {
    if (session.hasStorageState) {
      logger.info('Checking saved HIIB session', { path: settings.sessionStatePath });
      if (await hasLiveSession(page, config.hiibPolicySummaryReportUrl)) {
        logger.info('Reusing saved HIIB session', { url: page.url() });
        return { browser, context, page, reusedSession: true, close: session.close };
      }
      logger.info('Saved HIIB session expired; performing a fresh login');
    }

    const maxAttempts = Math.max(1, settings.loginRetries + 1);
    let lastMessage = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await attemptLogin(page, settings, attempt);

      if (result.outcome === 'success') {
        logger.info('HIIB login successful', { url: result.url, attempt });
        await saveSessionStateToPath(context, settings.sessionStatePath);
        return { browser, context, page, reusedSession: false, close: session.close };
      }

      if (result.outcome === 'password-reset-required') {
        throw new Error(
          'HIIB portal is forcing a password change for this user. ' +
          'Reset it in the portal, then update HIIB_PASSWORD in .env.'
        );
      }

      lastMessage = result.message || result.outcome;
      logger.warn('HIIB login attempt failed', { attempt, outcome: result.outcome, message: lastMessage });

      // The portal refreshes the captcha itself after a rejection, so a retry
      // starts from a clean form.
      await dismissMessageModal(page);

      if (isTerminalLoginMessage(lastMessage)) {
        throw new Error(
          `HIIB rejected the credentials for "${settings.userId}": ${lastMessage} ` +
          '(not retrying, to avoid tripping the portal lockout). ' +
          'Check HIIB_USER_ID / HIIB_PASSWORD in .env.'
        );
      }

      if (attempt < maxAttempts) {
        await sleep(2000);
      }
    }

    throw new Error(`HIIB login failed after ${maxAttempts} attempt(s): ${lastMessage}`);
  } catch (error) {
    const screenshotPath = path.join(config.rootDir, 'hiib-login-error.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    logger.error('HIIB login failed', error);
    logger.info('Saved HIIB failure screenshot', { path: screenshotPath });
    await browser.close().catch(() => {});
    throw error;
  }
}

export { SELECTORS as hiibLoginSelectors };
