import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './sleep.js';
import { logger } from './logger.js';

async function removeStaleLock(lockDir, staleMs, label) {
  const stat = await fs.stat(lockDir).catch(() => null);
  if (!stat) return false;

  const metaPath = path.join(lockDir, 'meta.json');
  const meta = await fs.readFile(metaPath, 'utf8')
    .then(value => JSON.parse(value))
    .catch(() => null);

  if (meta?.pid) {
    const lockPid = Number(meta.pid);
    const lockProcessAlive = Number.isInteger(lockPid) && lockPid > 0 && (() => {
      try {
        process.kill(lockPid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    if (!lockProcessAlive) {
      logger.warn('Removing filesystem lock held by dead process', {
        label,
        lockDir,
        pid: lockPid,
        acquiredAt: meta.acquiredAt
      });
      await fs.rm(lockDir, { recursive: true, force: true });
      return true;
    }
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < staleMs) return false;

  logger.warn('Removing stale filesystem lock', {
    label,
    lockDir,
    ageMs,
    staleMs
  });
  await fs.rm(lockDir, { recursive: true, force: true });
  return true;
}

export async function withDirectoryLock(lockDir, fn, {
  label = 'lock',
  timeoutMs = 300000,
  staleMs = 600000,
  pollMs = 500
} = {}) {
  const startedAt = Date.now();
  let acquired = false;

  await fs.mkdir(path.dirname(lockDir), { recursive: true });

  let lastWaitLogAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fs.mkdir(lockDir);
      acquired = true;
      await fs.writeFile(path.join(lockDir, 'meta.json'), JSON.stringify({
        label,
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      }, null, 2));
      logger.info('Filesystem lock acquired', { label, lockDir });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await removeStaleLock(lockDir, staleMs, label);

      const now = Date.now();
      if (now - lastWaitLogAt >= 10000) {
        lastWaitLogAt = now;
        const waitedSec = Math.round((now - startedAt) / 1000);
        const message = `Waiting for ${label} lock (${waitedSec}s)... Close the other GDMS login window or stop the other run.`;
        logger.warn(message, { label, lockDir, waitedSec });
        process.stdout.write(`${message}\n`);
      }

      await sleep(pollMs);
    }
  }

  if (!acquired) {
    throw new Error(`Timed out waiting for filesystem lock: ${label}`);
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
    logger.info('Filesystem lock released', { label, lockDir });
  }
}
