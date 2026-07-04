import { createServiceConfig } from '../../../packages/automation-core/config/service-config.js';

export const platinumServiceConfig = createServiceConfig({
  service: 'platinum',
  displayName: 'AM Platinum',
  triggerCron: '15 9 * * *',
  fallbackCron: '25 9 * * *',
  rolloutEnabled: false
});
