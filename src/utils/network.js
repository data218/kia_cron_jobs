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

function getTargetPortalUrl(label = '') {
  const lower = label.toLowerCase();
  if (lower.includes('rsa')) {
    return config.rsaPortalUrl || 'https://kia.awpassistance.in/report';
  }
  if (lower.includes('kia')) {
    return config.loginUrl || 'https://dms.kiaindia.net/cmm/cmmi/selectLoginMain.dms';
  }
  if (
    lower.includes('hyundai') ||
    lower.includes('hmil') ||
    lower.includes('platinum') ||
    lower.includes('sahiltech') ||
    lower.includes('mis5216') ||
    lower.includes('mis1988') ||
    lower.includes('mis12345')
  ) {
    return config.hmilLoginUrl || 'https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms';
  }
  return null;
}

export async function waitForConnectivity({
  label = 'network',
  timeoutMs = config.networkWaitTimeoutMs,
  intervalMs = config.networkRetryIntervalMs,
  failOpen = false
} = {}) {
  const startedAt = Date.now();
  let attempt = 0;

  const portalUrl = getTargetPortalUrl(label);
  const checkUrls = portalUrl ? [portalUrl] : networkCheckUrls();

  while (Date.now() - startedAt <= timeoutMs) {
    attempt += 1;
    if (await checkConnectivity({ urls: checkUrls })) {
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
      checkUrls
    });
    await sleep(intervalMs);
  }

  if (failOpen) {
    logger.warn('Network probe timed out; continuing anyway', {
      label,
      timeoutMs,
      checkUrls
    });
    return false;
  }

  throw new NetworkUnavailableError(`Network did not recover within ${timeoutMs}ms for ${label}`);
}
