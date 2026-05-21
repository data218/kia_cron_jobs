import { sleep } from './sleep.js';
import { logger } from './logger.js';

export async function retry(operation, { attempts, delayMs, label }) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        logger.info(`${label} retry attempt ${attempt}/${attempts}`);
      }
      return await operation({ attempt });
    } catch (error) {
      lastError = error;
      logger.error(`${label} attempt ${attempt} failed`, error);

      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}
