import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { createGdmsAccountScheduler } from '../src/cron/gdms-account-scheduler.js';

const account = createGdmsAccountProfile('hmil-secondary');
const scheduler = createGdmsAccountScheduler(account);

await scheduler.run(account.defaultMode);
