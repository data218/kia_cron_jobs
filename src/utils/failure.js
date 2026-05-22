import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

function safeName(value) {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function timestampForFile(date = new Date()) {
  return date.toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
}

export async function currentPageUrl(page) {
  try {
    return page?.url?.() ?? '';
  } catch {
    return '';
  }
}

export async function captureFailureScreenshot(page, name, attempt) {
  if (!page?.screenshot) {
    return null;
  }

  const filePath = path.join(
    config.screenshotsDir,
    `${safeName(name)}_failure_attempt_${attempt}_${timestampForFile()}.png`
  );

  try {
    await page.screenshot({
      path: filePath,
      fullPage: true
    });
    logger.info('Failure screenshot captured', { name, attempt, filePath });
    return filePath;
  } catch (error) {
    logger.warn('Failure screenshot capture failed', {
      name,
      attempt,
      message: error.message
    });
    return null;
  }
}
