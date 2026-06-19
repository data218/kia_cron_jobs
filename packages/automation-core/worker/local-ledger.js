import fs from 'node:fs/promises';
import path from 'node:path';

async function readLedger(filePath) {
  return fs.readFile(filePath, 'utf8')
    .then(value => JSON.parse(value))
    .catch(error => {
      if (error.code === 'ENOENT') return { runs: {} };
      throw error;
    });
}

export async function hasLocalRun(filePath, idempotencyKey) {
  const ledger = await readLedger(filePath);
  return Boolean(ledger.runs?.[idempotencyKey]);
}

export async function recordLocalRun(filePath, idempotencyKey, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const ledger = await readLedger(filePath);
  ledger.runs ??= {};
  ledger.runs[idempotencyKey] = {
    ...value,
    synced: value.synced ?? false,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(filePath, JSON.stringify(ledger, null, 2));
}

export async function listUnsyncedLocalRuns(filePath) {
  const ledger = await readLedger(filePath);
  return Object.entries(ledger.runs ?? {})
    .filter(([, value]) => !value.synced)
    .map(([idempotencyKey, value]) => ({ idempotencyKey, ...value }));
}

export async function markLocalRunSynced(filePath, idempotencyKey) {
  const ledger = await readLedger(filePath);
  if (!ledger.runs?.[idempotencyKey]) return;
  ledger.runs[idempotencyKey].synced = true;
  ledger.runs[idempotencyKey].syncedAt = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(ledger, null, 2));
}
