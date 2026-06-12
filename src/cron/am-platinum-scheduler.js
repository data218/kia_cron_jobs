import { createGdmsAccountProfile } from '../accounts/gdms-account-profile.js';
import { createGdmsAccountScheduler } from './gdms-account-scheduler.js';

const account = createGdmsAccountProfile('am-platinum');
const scheduler = createGdmsAccountScheduler(account);

export const runAmPlatinumDmsJob = scheduler.run;

await scheduler.runFromCliIfNeeded(import.meta.url, process.argv[1]);
