import { config } from '../src/config.js';

console.log('Testing webhook connectivity...');
console.log('Base URL:', config.otpWebhookBaseUrl);
console.log('Token:', config.otpWebhookToken);

try {
  const res = await fetch(`${config.otpWebhookBaseUrl}/otp/latest?purpose=hmil`, {
    headers: {
      authorization: `Bearer ${config.otpWebhookToken}`
    }
  });
  console.log('Response Status:', res.status);
  const data = await res.json();
  console.log('Response Body:', data);
} catch (err) {
  console.error('Error fetching from webhook:', err);
}
