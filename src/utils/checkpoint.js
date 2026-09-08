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

// A checkpoint describes one run, not the account. On 2026-09-01 a run ended with failures, the
// checkpoint froze at the first failed task, and every run afterwards resumed past it: three
// reports went untouched for days while the job still logged partial success. Anything that says
// "this belongs to a different run" - another mode, another task list, another calendar day (report
// date ranges roll over daily, so yesterday's progress means nothing), or a timestamp far too old
// to belong to a live run - must invalidate the checkpoint instead of silently shrinking the run.
export const CHECKPOINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function checkpointRetryIndexes(checkpoint, taskCount) {
  const indexes = Array.isArray(checkpoint?.failedIndexes) ? checkpoint.failedIndexes : [];
  return [...new Set(indexes)]
    .filter(index => Number.isInteger(index) && index >= 0 && index < taskCount)
    .sort((a, b) => a - b);
}

export function checkpointStaleReason(checkpoint, expected) {
  if (!checkpoint) {
    return 'no_checkpoint';
  }

  if (checkpoint.mode !== expected.mode) {
    return 'mode_changed';
  }

  if (checkpoint.runDate !== expected.runDate) {
    return 'different_run_date';
  }

  if (JSON.stringify(checkpoint.taskKeys ?? []) !== JSON.stringify(expected.taskKeys ?? [])) {
    return 'task_list_changed';
  }

  const taskCount = expected.taskKeys?.length ?? 0;
  if (!Number.isInteger(checkpoint.nextIndex) || checkpoint.nextIndex < 0 || checkpoint.nextIndex > taskCount) {
    return 'invalid_next_index';
  }

  // A checkpoint only survives a genuinely interrupted run. Once the loop has walked the whole
  // task list the checkpoint is spent, even if some tasks failed: the schedules run twice a day
  // (HMIL 11:00 and 19:40, AM Platinum 10:00 and 16:00), and honouring a completed checkpoint
  // would shrink that second run down to the failed tasks alone and skip every healthy report.
  // Failures are re-attempted by the next full run, which starts from task 0 anyway.
  if (checkpoint.nextIndex >= taskCount) {
    return 'run_already_complete';
  }

  const updatedAtMs = Date.parse(checkpoint.updatedAt ?? '');
  if (!Number.isFinite(updatedAtMs)) {
    return 'missing_timestamp';
  }

  if (Date.now() - updatedAtMs > CHECKPOINT_MAX_AGE_MS) {
    return 'expired';
  }

  return null;
}

export async function clearCheckpoint(name) {
  const filePath = checkpointPath(name);
  await fs.unlink(filePath).catch(() => {});
  logger.info('Checkpoint cleared', {
    checkpoint: name,
    filePath
  });
}
