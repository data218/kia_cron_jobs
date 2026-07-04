import { logger } from '../utils/logger.js';
import { withPostgresClient } from './postgres.js';

const DASHBOARD_MATERIALIZED_VIEWS = [
  'workshop_performance_jc_summary_v1',
  'workshop_operation_addon_summary_v1'
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export async function refreshDashboardMaterializedViews() {
  try {
    return await withPostgresClient(async client => {
      for (const viewName of DASHBOARD_MATERIALIZED_VIEWS) {
        const startedAt = Date.now();

        logger.info('Dashboard materialized view refresh started', { viewName });

        try {
          await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY public.${quoteIdentifier(viewName)}`);
          logger.info('Dashboard materialized view refresh completed', {
            viewName,
            durationMs: Date.now() - startedAt
          });
        } catch (error) {
          logger.error('Dashboard materialized view refresh failed', {
            viewName,
            durationMs: Date.now() - startedAt,
            err: {
              name: error.name,
              message: error.message,
              stack: error.stack
            }
          });
        }
      }
    });
  } catch (error) {
    logger.warn('Dashboard materialized view refresh skipped (database not reachable)', {
      message: error.message
    });
  }
}
