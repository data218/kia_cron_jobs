import { config } from '../config.js';
import { logger } from './logger.js';
import { sleep } from './sleep.js';

export class NetworkUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkUnavailableError';
  }
}

function networkCheckUrls() {
  if (config.networkCheckUrls.length) {
    return config.networkCheckUrls;
  }

  return [config.networkCheckUrl].filter(Boolean);
}

async function checkSingleUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });

    return response.ok || response.status === 204 || response.status === 304;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkConnectivity({
  url,
  urls = networkCheckUrls(),
  timeoutMs = config.networkCheckTimeoutMs
} = {}) {
  const targets = url ? [url] : urls;
  for (const target of targets) {
    if (await checkSingleUrl(target, timeoutMs)) {
      return true;
    }
  }

  return false;
}

export async function waitForConnectivity({
  label = 'network',
  timeoutMs = config.networkWaitTimeoutMs,
  intervalMs = config.networkRetryIntervalMs,
  failOpen = false
} = {}) {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    attempt += 1;
    if (await checkConnectivity()) {
      if (attempt > 1) {
        logger.info('Network connectivity restored', {
          label,
          attempts: attempt,
          waitedMs: Date.now() - startedAt
        });
      }
      return true;
    }

    logger.warn('Network connectivity unavailable; waiting before continuing', {
      label,
      attempt,
      retryInMs: intervalMs,
      checkUrls: networkCheckUrls()
    });
    await sleep(intervalMs);
  }

  if (failOpen) {
    logger.warn('Network probe timed out; continuing anyway', {
      label,
      timeoutMs,
      checkUrls: networkCheckUrls()
    });
    return false;
  }

  throw new NetworkUnavailableError(`Network did not recover within ${timeoutMs}ms for ${label}`);
}
