import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ngrokPath = process.env.NGROK_EXE_PATH || 'ngrok';
const publicUrl = process.env.OTP_PUBLIC_WEBHOOK_URL;
const port = process.env.OTP_WEBHOOK_PORT || '3333';

if (!publicUrl) {
  throw new Error('OTP_PUBLIC_WEBHOOK_URL is required to start the ngrok tunnel');
}

if (ngrokPath !== 'ngrok' && !fs.existsSync(ngrokPath)) {
  throw new Error(`NGROK_EXE_PATH does not exist: ${ngrokPath}`);
}

function startTunnel(useReservedUrl = true) {
  const args = ['http', port, '--log', 'stdout', '--log-format', 'logfmt'];
  if (useReservedUrl && publicUrl) {
    args.push('--url', publicUrl);
  }

  const child = spawn(ngrokPath, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stderr = '';
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));

  child.on('exit', (code, signal) => {
    if (code !== 0 && useReservedUrl && /ERR_NGROK_334|already online/i.test(stderr)) {
      console.warn('Reserved ngrok URL is already in use elsewhere; starting dynamic tunnel instead.');
      startTunnel(false);
      return;
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

startTunnel(true);

