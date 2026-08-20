import fs from 'node:fs/promises';
import path from 'node:path';

const dir = 'logs/screenshots';
const files = await fs.readdir(dir);
const fileDetails = [];

for (const file of files) {
  const stat = await fs.stat(path.join(dir, file));
  fileDetails.push({ name: file, mtime: stat.mtime, size: stat.size });
}

fileDetails.sort((a, b) => b.mtime - a.mtime);

console.log('Latest 10 screenshots:');
for (const detail of fileDetails.slice(0, 10)) {
  console.log(`${detail.name} - ${detail.mtime.toISOString()} - ${detail.size} bytes`);
}
