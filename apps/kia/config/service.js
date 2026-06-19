import { createServiceConfig } from '../../../packages/automation-core/config/service-config.js';

export const kiaServiceConfig = createServiceConfig({
  service: 'kia',
  displayName: 'KIA',
  triggerCron: '0 9 * * *',
  fallbackCron: '10 9 * * *',
  rolloutEnabled: true
});
