import { config } from '../config.js';
import { logger } from './logger.js';
import { sleep } from './sleep.js';

export class NetworkUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkUnavailableError';
  }
}

export async function checkConnectivity({
  url = config.networkCheckUrl,
  timeoutMs = config.networkCheckTimeoutMs
} = {}) {
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

export async function waitForConnectivity({
  label = 'network',
  timeoutMs = config.networkWaitTimeoutMs,
  intervalMs = config.networkRetryIntervalMs
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
      retryInMs: intervalMs
    });
    await sleep(intervalMs);
  }

  throw new NetworkUnavailableError(`Network did not recover within ${timeoutMs}ms for ${label}`);
}
