import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dailyIdempotencyKey } from '../packages/automation-core/config/service-config.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const services = ['kia', 'platinum', 'hmil'];

async function listJavaScriptFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
  }));
  return nested.flat();
}

test('application code does not import another application', async () => {
  for (const service of services) {
    const files = await listJavaScriptFiles(path.join(rootDir, 'apps', service));
    const forbidden = services.filter(candidate => candidate !== service);
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      for (const candidate of forbidden) {
        assert.doesNotMatch(
          source,
          new RegExp(`apps[\\\\/]${candidate}[\\\\/]`),
          `${path.relative(rootDir, file)} imports the ${candidate} app`
        );
      }
    }
  }
});

test('daily keys use the Asia/Kolkata calendar date', () => {
  const instant = new Date('2026-06-18T20:00:00.000Z');
  assert.equal(dailyIdempotencyKey('kia', instant), 'kia:2026-06-19:daily');
});

test('PM2 replaces the legacy KIA scheduler with the queue worker', async () => {
  const ecosystem = await fs.readFile(path.join(rootDir, 'ecosystem.config.cjs'), 'utf8');
  assert.match(ecosystem, /name: 'kia-worker'/);
  assert.doesNotMatch(ecosystem, /name: 'kia-cron-job'/);
  assert.match(ecosystem, /name: 'platinum-worker'/);
  assert.match(ecosystem, /name: 'hmil-worker'/);
});

test('Supabase schedules preserve KIA, Platinum, HMIL trigger order', async () => {
  const migration = await fs.readFile(
    path.join(rootDir, 'supabase', 'migrations', '20260618091000_automation_schedules.sql'),
    'utf8'
  );
  assert.ok(migration.indexOf("'30 3 * * *'") < migration.indexOf("'45 3 * * *'"));
  assert.ok(migration.indexOf("'45 3 * * *'") < migration.indexOf("'50 3 * * *'"));
});
