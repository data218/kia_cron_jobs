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

export async function loginToKiaDms() {
  requireSecret('KIA_PASSWORD', config.password);
  logger.info('KIA DMS login started');

  const session = await createBrowserSession();
  const { browser, context, page, hasStorageState } = session;

  try {
    let loginPageAlreadyLoaded = false;

    if (hasStorageState) {
      if (await hasExistingSession(page)) {
        return { browser, context, page, reusedSession: true };
      }
      loginPageAlreadyLoaded = true;
    }

    if (!loginPageAlreadyLoaded) {
      logger.info('Opening KIA DMS login page', { url: config.loginUrl });
      await page.goto(config.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.loginTimeoutMs
      });
      logger.info('KIA DMS login page navigation completed', { url: page.url() });
    }

    logger.info('Login page loaded; waiting briefly before entering credentials', {
      delayMs: config.pageReadyDelayMs
    });
    await sleep(config.pageReadyDelayMs);

    logger.info('Filling KIA DMS credentials');
    const userIdInput = await firstVisible(page, selectors.userId);
    await userIdInput.fill(config.userId);

    const passwordInput = await firstVisible(page, selectors.password);
    await passwordInput.fill(config.password);

    logger.info('Requesting OTP');
    const sendOtpButton = await firstVisible(page, selectors.sendOtp);
    const otpRequestedAt = new Date();
    logger.info('Clicking Send OTP and waiting for KIA DMS response');
    await clickAndWait(page, sendOtpButton, 10000);
    logger.info('Send OTP click completed; waiting for OTP input');

    const otpInput = await firstVisible(page, selectors.otp, config.otpTimeoutMs);
    logger.info('OTP input is ready; waiting for OTP provider', {
      provider: config.otpProvider
    });
    const otp = await getOtp({ notBefore: otpRequestedAt });
    await otpInput.fill(otp);

    logger.info('Submitting OTP');
    const submitButton = await firstVisible(page, selectors.submit);
    await clickAndWait(page, submitButton, config.loginTimeoutMs);

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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const session = await loginToKiaDms();
  await session.browser.close();
}
