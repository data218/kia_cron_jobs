import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function getOtpManual({ timeoutMs }) {
  const rl = readline.createInterface({ input, output });

  try {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for manual OTP entry')), timeoutMs);
    });

    const answer = await Promise.race([
      rl.question('Enter KIA DMS OTP: '),
      timeout
    ]);

    const otp = String(answer).trim();
    if (!/^\d{4,8}$/.test(otp)) {
      throw new Error('OTP must be 4 to 8 digits');
    }

    return otp;
  } finally {
    rl.close();
  }
}
