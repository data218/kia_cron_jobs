import fs from 'node:fs/promises';
import { listAmPlatinumSessionCachePaths } from '../src/accounts/am-platinum-accounts.js';

async function deleteIfExists(filePath) {
  try {
    await fs.unlink(filePath);
    console.log(`Removed ${filePath}`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not remove ${filePath}: ${error.message}`);
    }
    return false;
  }
}

async function main() {
  const paths = listAmPlatinumSessionCachePaths();
  let removed = 0;

  for (const statePath of paths) {
    if (await deleteIfExists(statePath)) removed += 1;
    if (await deleteIfExists(`${statePath}.meta.json`)) removed += 1;
  }

  console.log(`AM Platinum session cache clear finished (${removed} file(s) removed).`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
