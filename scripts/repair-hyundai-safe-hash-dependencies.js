import { withPostgresClient } from '../src/supabase/postgres.js';
import { logger } from '../src/utils/logger.js';

async function repairHyundaiSafeHashDependencies(client) {
  await client.query('create extension if not exists pgcrypto');

  await client.query(`
    create or replace function public.hyundai_normalize_active_dealer_code(value text)
    returns text
    language sql
    immutable
    as $$
      select case
        when nullif(upper(trim(both from coalesce(value, ''))), '') in ('ACTIVE', 'CURRENT', 'DEFAULT') then null
        else nullif(upper(trim(both from coalesce(value, ''))), '')
      end
    $$;
  `);

  await client.query(`
    create or replace function public.hyundai_operation_safe_hash_trigger()
    returns trigger
    language plpgsql
    as $$
    begin
      new.source_dealer_code := public.hyundai_normalize_active_dealer_code(new.source_dealer_code);
      new.dealer_code := public.hyundai_normalize_active_dealer_code(new.dealer_code);
      new.row_hash := encode(
        digest((((to_jsonb(new) - 'id') - 'row_hash') - 'uploaded_at')::text, 'sha256'),
        'hex'
      );
      return new;
    end
    $$;
  `);

  await client.query(`
    create or replace function public.hyundai_ro_billing_safe_hash_trigger()
    returns trigger
    language plpgsql
    as $$
    begin
      new.source_dealer_code := public.hyundai_normalize_active_dealer_code(new.source_dealer_code);
      new.dealer_code := public.hyundai_normalize_active_dealer_code(new.dealer_code);
      new.main_dealer_code := public.hyundai_normalize_active_dealer_code(new.main_dealer_code);
      new.dealer_code_2 := public.hyundai_normalize_active_dealer_code(new.dealer_code_2);
      new.row_hash := encode(
        digest((((to_jsonb(new) - 'id') - 'row_hash') - 'uploaded_at')::text, 'sha256'),
        'hex'
      );
      return new;
    end
    $$;
  `);
}

await withPostgresClient(async client => {
  await repairHyundaiSafeHashDependencies(client);
});

logger.info('Repaired Hyundai safe-hash trigger dependencies');
