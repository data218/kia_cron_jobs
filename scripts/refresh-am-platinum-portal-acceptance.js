import { refreshPortalEmptyAcceptancesFromPriorityStates } from '../src/am-platinum/portal-empty-acceptance.js';

const entries = await refreshPortalEmptyAcceptancesFromPriorityStates();
console.log(`Portal empty acceptance refreshed: ${entries.length} entries`);
