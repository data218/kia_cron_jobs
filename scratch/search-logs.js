import fs from 'node:fs/promises';

const logContent = await fs.readFile('logs/pm2-hmil-out.log', 'utf8');
const lines = logContent.split('\n');

let print = false;
let printed = 0;
console.log('Daily cron dealer change logs around 1:30 PM:');
for (const line of lines) {
  if (line.includes('2026-06-26T13:30:17')) {
    print = true;
  }
  if (print) {
    console.log(line);
    printed++;
    if (printed > 25) break;
  }
}
