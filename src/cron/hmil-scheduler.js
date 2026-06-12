import { createGdmsAccountProfile } from '../accounts/gdms-account-profile.js';
import { createGdmsAccountScheduler } from './gdms-account-scheduler.js';

const account = createGdmsAccountProfile('hmil');
const scheduler = createGdmsAccountScheduler(account);

export const runHmilDmsJob = scheduler.run;

await scheduler.runFromCliIfNeeded(import.meta.url, process.argv[1]);
