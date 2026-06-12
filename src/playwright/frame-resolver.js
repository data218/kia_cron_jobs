import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

async function isVisibleInContext(context, selector) {
  return context.locator(selector).first().isVisible({ timeout: 50 }).catch(() => false);
}

export async function findContextWithVisibleSelector(page, selector, { timeout = 60000, label = selector } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    if (await isVisibleInContext(page, selector)) {
      logger.info('Found selector in main page', { label, selector });
      return page;
    }

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await isVisibleInContext(frame, selector)) {
        logger.info('Found selector in frame', {
          label,
          selector,
          frameName: frame.name(),
          frameUrl: frame.url()
        });
        return frame;
      }
    }

    await sleep(50);
  }

  const frames = page.frames().map(frame => ({
    name: frame.name(),
    url: frame.url()
  }));

  throw new Error(`Could not find visible selector in page or frames: ${selector}. Frames: ${JSON.stringify(frames)}`);
}
