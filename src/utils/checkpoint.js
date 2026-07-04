import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

function checkpointDir() {
  return path.join(config.logsDir, 'checkpoints');
}

function checkpointPath(name) {
  return path.join(checkpointDir(), `${String(name).trim()}.json`);
}

export async function readCheckpoint(name) {
  try {
    const filePath = checkpointPath(name);
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    logger.warn('Failed to read checkpoint file', {
      checkpoint: name,
      message: error.message
    });
    return null;
  }
}

export async function writeCheckpoint(name, payload) {
  const filePath = checkpointPath(name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    ...payload
  }, null, 2));
  logger.info('Checkpoint updated', {
    checkpoint: name,
    filePath
  });
}

export async function clearCheckpoint(name) {
  const filePath = checkpointPath(name);
  await fs.unlink(filePath).catch(() => {});
  logger.info('Checkpoint cleared', {
    checkpoint: name,
    filePath
  });
}
