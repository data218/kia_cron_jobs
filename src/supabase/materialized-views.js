import { logger } from '../utils/logger.js';
import { withPostgresClient } from './postgres.js';

const DASHBOARD_MATERIALIZED_VIEWS = [
  'workshop_performance_jc_summary_v1',
  'workshop_operation_addon_summary_v1'
];

const AM_PLATINUM_MATERIALIZED_VIEWS = [
  'am_platinum_vas_period_summary_v1'
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function refreshViewList(client, viewNames, label) {
  for (const viewName of viewNames) {
    const startedAt = Date.now();
    logger.info(`${label} materialized view refresh started`, { viewName });

    try {
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY public.${quoteIdentifier(viewName)}`);
      logger.info(`${label} materialized view refresh completed`, {
        viewName,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      logger.error(`${label} materialized view refresh failed`, {
        viewName,
        durationMs: Date.now() - startedAt,
        err: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      });
      throw error;
    }
  }
}

export async function refreshDashboardMaterializedViews() {
  return withPostgresClient(async client => {
    await refreshViewList(client, DASHBOARD_MATERIALIZED_VIEWS, 'Dashboard');
  });
}

export async function refreshAmPlatinumMaterializedViews() {
  return withPostgresClient(async client => {
    await refreshViewList(client, AM_PLATINUM_MATERIALIZED_VIEWS, 'AM Platinum');
  });
}
