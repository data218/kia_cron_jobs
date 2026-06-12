import fs from 'node:fs/promises';
import { config } from '../config.js';

export async function ensureRuntimeDirs() {
  await Promise.all([
    fs.mkdir(config.logsDir, { recursive: true }),
    fs.mkdir(config.screenshotsDir, { recursive: true }),
    fs.mkdir(config.downloadDir, { recursive: true }),
    fs.mkdir(config.reportChunksDir, { recursive: true }),
    fs.mkdir(config.mergedDir, { recursive: true }),
    fs.mkdir(config.tempDir, { recursive: true })
  ]);
}
