import { createServiceConfig } from '../../../packages/automation-core/config/service-config.js';

export const hmilServiceConfig = createServiceConfig({
  service: 'hmil',
  displayName: 'HMIL',
  triggerCron: '20 9 * * *',
  fallbackCron: '30 9 * * *',
  rolloutEnabled: false
});
