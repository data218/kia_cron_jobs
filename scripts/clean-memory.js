import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execPromise = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}] Starting memory cleaning process...`);
  
  const scriptPath = path.resolve(__dirname, '../clean-memory.ps1');
  try {
    const { stdout, stderr } = await execPromise(`powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}"`);
    console.log(stdout);
    if (stderr) {
      console.error("Errors/Warnings during memory cleaning:\n", stderr);
    }
  } catch (error) {
    console.error("Execution failed:", error);
    process.exit(1);
  }
}

run();
