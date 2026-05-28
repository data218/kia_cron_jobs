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

const args = [
  'http',
  port,
  '--url',
  publicUrl,
  '--log',
  'stdout',
  '--log-format',
  'logfmt'
];

const child = spawn(ngrokPath, args, {
  stdio: 'inherit',
  windowsHide: true
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
