import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

export async function writeHealthStatus(status) {
  const payload = {
    service: 'kia-cron-job',
    env: process.env.NODE_ENV || 'development',
    updatedAt: new Date().toISOString(),
    ...status
  };

  const filePath = path.join(config.logsDir, 'health.json');
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  logger.info('Health status updated', {
    status: payload.status,
    filePath
  });
}
