import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execPromise = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  console.log("Starting database restart process via PM2...");
  const scriptPath = path.resolve(__dirname, '../restart-db.ps1');
  try {
    const { stdout, stderr } = await execPromise(`powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}"`);
    console.log("Stdout:\n", stdout);
    if (stderr) {
      console.error("Stderr:\n", stderr);
    }
  } catch (error) {
    console.error("Execution failed:", error);
    process.exit(1);
  }
}
run();
