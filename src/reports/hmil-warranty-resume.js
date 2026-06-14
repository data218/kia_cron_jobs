import { withPostgresClient } from '../supabase/postgres.js';

const CLAIM_LIST_TABLE = 'hyundai_warranty_claim_list';
const CLAIM_YTP_TABLE = 'hyundai_warranty_claim_ytp';

function normalizeDealerCode(dealerCode) {
  return String(dealerCode || '').trim().toUpperCase();
}

function normalizeLoginId(sourceLoginId) {
  return String(sourceLoginId || '').trim();
}

export async function getWarrantyClaimListCoveredMonths(sourceLoginId, dealerCode) {
  return withPostgresClient(async client => {
    const result = await client.query(
      `SELECT DISTINCT to_char(claim_date::date, 'YYYY-MM') AS ym
       FROM public.${CLAIM_LIST_TABLE}
       WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))
         AND lower(trim(source_login_id::text)) = lower(trim($2::text))
         AND claim_date IS NOT NULL
       ORDER BY 1`,
      [normalizeDealerCode(dealerCode), normalizeLoginId(sourceLoginId)]
    );
    return new Set(result.rows.map(row => row.ym));
  });
}

export async function hasWarrantyClaimYtpData(sourceLoginId, dealerCode) {
  return withPostgresClient(async client => {
    const result = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM public.${CLAIM_YTP_TABLE}
         WHERE upper(trim(source_dealer_code::text)) = upper(trim($1::text))
           AND lower(trim(source_login_id::text)) = lower(trim($2::text))
       ) AS has_data`,
      [normalizeDealerCode(dealerCode), normalizeLoginId(sourceLoginId)]
    );
    return Boolean(result.rows[0]?.has_data);
  });
}
