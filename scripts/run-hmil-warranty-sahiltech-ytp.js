// Prefer: npm run hmil:warranty:historical
import { runHmilWarrantyJob } from '../src/cron/hmil-warranty-scheduler.js';

await runHmilWarrantyJob('historical');
