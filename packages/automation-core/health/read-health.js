import fs from 'node:fs/promises';

export async function readHealthFile(filePath) {
  return fs.readFile(filePath, 'utf8').then(value => JSON.parse(value));
}

export function assertSuccessfulHealth(health, label) {
  if (!health || !['success', 'completed_with_failures'].includes(health.status)) {
    const error = new Error(`${label} did not finish successfully`);
    error.health = health;
    throw error;
  }
  return health;
}
