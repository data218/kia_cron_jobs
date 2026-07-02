import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, requireSecret } from '../config.js';
import { getOtp } from '../otp/index.js';
import {
  clickAndWait,
  createBrowserSession,
  firstVisible,
  saveSessionState
} from '../playwright/browser.js';
import { selectors } from '../playwright/selectors.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

async function hasExistingSession(page) {
  try {
    logger.info('Checking saved KIA DMS session', { url: config.loginUrl });
    await page.goto(config.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.loginTimeoutMs
    });
    logger.info('Saved-session check page loaded', { url: page.url() });

    const passwordField = page.locator(selectors.password.join(',')).first();
    const isLoginPage = await passwordField.isVisible({ timeout: 1500 }).catch(() => false);

    if (isLoginPage) {
      logger.warn('Saved session is expired or not accepted by KIA DMS');
      return false;
    }

    logger.info('Session restored; OTP login skipped');
    return true;
  } catch (error) {
    logger.warn('Could not verify saved session; full login will be attempted', {
      message: error.message
    });
    return false;
  }
}

async function isKiaHomeVisible(page, timeout = 500) {
  return page.locator('li.nav_ser_mis, li.nav_ser, #gnb').first()
    .isVisible({ timeout })
    .catch(() => false);
}

async function waitForOtpInputOrHome(page, timeoutMs) {
  const startedAt = Date.now();
  const otpSelector = selectors.otp.join(',');

  while (Date.now() - startedAt < timeoutMs) {
    if (await isKiaHomeVisible(page, 50)) {
      return { status: 'home' };
    }

    const otpInput = page.locator(otpSelector).first();
    if (await otpInput.isVisible({ timeout: 50 }).catch(() => false)) {
      return { status: 'otp', locator: otpInput };
    }

    await sleep(50);
  }

  throw new Error(`Could not find visible KIA OTP input or logged-in home within ${timeoutMs}ms`);
}

async function ensureKiaHome(page) {
  const homeMenuVisible = await page.locator('li.nav_ser_mis, li.nav_ser, #gnb').first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true)
    .catch(() => false);

  if (!homeMenuVisible || /selectLoginAction\.json/i.test(page.url())) {
    logger.warn('KIA DMS home menu not visible after login step; opening home page directly', {
      currentUrl: page.url()
    });
    await page.goto('https://dms.kiaindia.net/cmm/cmmd/selectHome.dms', {
      waitUntil: 'domcontentloaded',
      timeout: config.loginTimeoutMs
    });
    await page.locator('li.nav_ser_mis, li.nav_ser, #gnb').first()
      .waitFor({ state: 'visible', timeout: config.loginTimeoutMs });
  }
}

export async function loginToKiaDms() {
  requireSecret('KIA_PASSWORD', config.password);
  logger.info('KIA DMS login started');

  const session = await createBrowserSession();
  const { browser, context, page, hasStorageState } = session;

  try {
    let loginPageAlreadyLoaded = false;

    if (hasStorageState && !config.kiaForceLogin) {
      if (await hasExistingSession(page)) {
        return { browser, context, page, reusedSession: true };
      }
      loginPageAlreadyLoaded = true;
    } else if (hasStorageState && config.kiaForceLogin) {
      logger.info('KIA_FORCE_LOGIN enabled; saved session check skipped for manual OTP testing');
    }

    if (!loginPageAlreadyLoaded) {
      logger.info('Opening KIA DMS login page', { url: config.loginUrl });
      await page.goto(config.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.loginTimeoutMs
      });
      logger.info('KIA DMS login page navigation completed', { url: page.url() });
    }

    if (config.pageReadyDelayMs > 0) {
      logger.info('Login page loaded; waiting briefly before entering credentials', {
        delayMs: config.pageReadyDelayMs
      });
      await sleep(config.pageReadyDelayMs);
    }

    logger.info('Filling KIA DMS credentials');
    const userIdInput = await firstVisible(page, selectors.userId, 3000);
    await userIdInput.fill(config.userId);

    const passwordInput = await firstVisible(page, selectors.password, 3000);
    await passwordInput.fill(config.password);

    logger.info('Requesting OTP');
    const sendOtpButton = await firstVisible(page, selectors.sendOtp, 5000);
    const otpRequestedAt = new Date();
    logger.info('Clicking Send OTP and waiting for KIA DMS response');
    await clickAndWait(page, sendOtpButton, 10000);
    logger.info('Send OTP click completed; waiting for OTP input or KIA home');

    const otpState = await waitForOtpInputOrHome(page, config.otpTimeoutMs);
    if (otpState.status === 'home') {
      logger.info('KIA DMS home is visible after Send OTP; OTP input skipped');
      await saveSessionState(context);
      logger.info('KIA DMS login success');
      return { browser, context, page, reusedSession: false };
    }

    const otpInput = otpState.locator;
    logger.info('OTP input is ready; waiting for OTP provider', {
      provider: config.otpProvider
    });
    const otp = await getOtp({ notBefore: otpRequestedAt, purpose: 'kia' });
    await otpInput.fill(otp);

    logger.info('Submitting OTP');
    const submitButton = await firstVisible(page, selectors.submit, 5000);
    await clickAndWait(page, submitButton, config.loginTimeoutMs);

    await ensureKiaHome(page);

    await saveSessionState(context);
    logger.info('KIA DMS login success');

    return { browser, context, page, reusedSession: false };
  } catch (error) {
    const screenshotPath = path.join(config.rootDir, 'login-error.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    logger.error('KIA DMS login failure', error);
    logger.info('Saved failure screenshot', { path: screenshotPath });
    await browser.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const session = await loginToKiaDms();
  await session.browser.close();
}
