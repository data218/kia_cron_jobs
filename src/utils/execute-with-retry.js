import { config } from '../config.js';
import { sleep } from './sleep.js';
import { logger } from './logger.js';
import { sendFailureEmail } from './notifier.js';
import { captureFailureScreenshot, currentPageUrl } from './failure.js';
import { waitForConnectivity } from './network.js';

function randomDelay(min, max) {
  const safeMin = Math.max(0, min);
  const safeMax = Math.max(safeMin, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

export async function executeWithRetry({
  name,
  fn,
  page,
  retries = config.reportMaxRetries,
  retryDelayMinMs = config.reportRetryDelayMinMs,
  retryDelayMaxMs = config.reportRetryDelayMaxMs
}) {
  const startedAt = new Date();
  let lastError;
  let lastScreenshotPath = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      await waitForConnectivity({ label: `${name} attempt ${attempt}` });
      logger.info('Report attempt started', {
        name,
        attempt,
        retries
      });

      const result = await fn({ attempt });
      logger.info('Report attempt completed', {
        name,
        attempt,
        durationMs: Date.now() - attemptStartedAt
      });
      return result;
    } catch (error) {
      lastError = error;
      const url = await currentPageUrl(page);
      lastScreenshotPath = await captureFailureScreenshot(page, name, attempt);

      logger.error('Report attempt failed', {
        name,
        attempt,
        retries,
        durationMs: Date.now() - attemptStartedAt,
        currentUrl: url,
        screenshotPath: lastScreenshotPath,
        err: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      });

      if (attempt < retries) {
        const delayMs = randomDelay(retryDelayMinMs, retryDelayMaxMs);
        logger.warn('Retrying report after delay', {
          name,
          attempt,
          nextAttempt: attempt + 1,
          retryDelayMs: delayMs
        });
        await sleep(delayMs);
      }
    }
  }

  const finishedAt = new Date();
  await sendFailureEmail({
    reportName: name,
    error: lastError,
    retriesAttempted: retries,
    startedAt,
    finishedAt,
    screenshotPath: lastScreenshotPath,
    currentUrl: await currentPageUrl(page),
    exportStatus: 'failed'
  }).catch(error => {
    logger.error('Failure email send failed', error);
  });

  throw lastError;
}
