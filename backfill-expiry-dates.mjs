import fs from 'node:fs/promises';
import path from 'node:path';
import { saveReportSheetToSupabaseRest } from './src/supabase/relational-store.js';

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsvFile(content) {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.length === 0) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }
  return { headers, rows };
}

const csvDir = path.resolve('downloads/report-chunks/kia-safety');
const entries = await fs.readdir(csvDir, { withFileTypes: true });
const csvDirs = entries
  .filter(e => e.isDirectory() && e.name.startsWith('export_'))
  .map(e => path.join(csvDir, e.name, 'export.csv'));

const existing = [];
for (const f of csvDirs) {
  try {
    const s = await fs.stat(f);
    if (s.size > 0) existing.push(f);
  } catch { /* skip */ }
}

console.log(`Found ${existing.length} CSV files to backfill`);

for (const csvPath of existing) {
  const text = await fs.readFile(csvPath, 'utf-8');
  const { headers, rows } = parseCsvFile(text);
  console.log(`  ${path.basename(path.dirname(csvPath))}: ${rows.length} rows`);
  const result = await saveReportSheetToSupabaseRest({
    sheetName: 'Kia Insurance',
    headers,
    rows,
    batchSize: 500,
  });
  console.log(`  => inserted=${result.insertedRowCount} dups=${result.duplicateRowCount}`);
}

console.log('Done backfilling expiry dates!');
