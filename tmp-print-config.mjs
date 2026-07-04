import { config } from './src/config.js';

console.log('=== KIA CONFIG ===');
console.log('userId:', config.userId);
console.log('primaryDealerCode:', config.primaryDealerCode);
console.log('additionalDealerCodes:', config.additionalDealerCodes);
console.log('reportsToRun:', config.reportsToRun);
console.log('cronSchedule:', config.cronSchedule);
console.log('otpProvider:', config.otpProvider);
console.log('otpWebhookBaseUrl:', config.otpWebhookBaseUrl);
