import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

async function ensureDir(fileOrDirPath) {
  const dir = path.extname(fileOrDirPath) ? path.dirname(fileOrDirPath) : fileOrDirPath;
  await fs.mkdir(dir, { recursive: true });
}

export async function sessionStateExists() {
  return fs.access(config.sessionStatePath).then(() => true).catch(() => false);
}

export async function clearSessionState() {
  await fs.unlink(config.sessionStatePath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function createBrowserSession() {
  await ensureDir(config.sessionStatePath);
  await ensureDir(config.downloadDir);

  const hasStorageState = await sessionStateExists();
  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMoMs,
    downloadsPath: config.downloadDir
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: hasStorageState ? config.sessionStatePath : undefined
  });
  const page = await context.newPage();

  if (hasStorageState) {
    logger.info('Loaded saved Playwright storage state');
  }

  return {
    browser,
    context,
    page,
    hasStorageState,
    close: () => browser.close()
  };
}

export async function createBrowserSessionWithState(statePath = config.sessionStatePath) {
  await ensureDir(statePath);
  await ensureDir(config.downloadDir);

  const hasStorageState = await fs.access(statePath).then(() => true).catch(() => false);
  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMoMs,
    downloadsPath: config.downloadDir
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: hasStorageState ? statePath : undefined
  });
  const page = await context.newPage();

  if (hasStorageState) {
    logger.info('Loaded saved Playwright storage state', { path: statePath });
  }

  return {
    browser,
    context,
    page,
    hasStorageState,
    close: () => browser.close()
  };
}

export async function createPersistentBrowserSession(userDataDir = config.rsaUserDataDir) {
  await ensureDir(userDataDir);
  await ensureDir(config.downloadDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: config.headless,
    slowMo: config.slowMoMs,
    acceptDownloads: true,
    downloadsPath: config.downloadDir
  });
  const page = context.pages().find(candidate =>
    candidate.url().includes('kia.awpassistance.in')
  ) ?? context.pages()[0] ?? await context.newPage();

  logger.info('Opened persistent browser profile', { userDataDir });

  return {
    browser: null,
    context,
    page,
    hasStorageState: true,
    close: () => context.close()
  };
}

export async function createCdpBrowserSession(endpoint) {
  await ensureDir(config.downloadDir);

  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] ?? await browser.newContext({
    acceptDownloads: true
  });
  const page = context.pages().find(candidate =>
    candidate.url().includes('kia.awpassistance.in')
  ) ?? context.pages()[0] ?? await context.newPage();

  logger.info('Attached to existing Chrome over CDP', { endpoint });

  return {
    browser,
    context,
    page,
    hasStorageState: true,
    connectedOverCdp: true,
    close: async () => {
      logger.info('Leaving attached Chrome session open');
    }
  };
}

export async function saveSessionStateToPath(context, statePath = config.sessionStatePath) {
  await ensureDir(statePath);
  await context.storageState({ path: statePath });
  logger.info('Saved browser session/cookies', { path: statePath });
}

export async function saveSessionState(context) {
  await context.storageState({ path: config.sessionStatePath });
  logger.info('Saved browser session/cookies', { path: config.sessionStatePath });
}

export async function firstVisible(page, candidates, timeout = 10000) {
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch {
      // Try the next selector.
    }
  }

  throw new Error(`Could not find visible element from selectors: ${candidates.join(', ')}`);
}

export async function clickAndWait(page, locator, timeout) {
  await locator.click();
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}
