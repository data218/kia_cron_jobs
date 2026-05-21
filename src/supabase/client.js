import { createClient } from '@supabase/supabase-js';
import { config, requireSecret } from '../config.js';

export function createSupabaseClient() {
  requireSecret('SUPABASE_URL', config.supabaseUrl);

  const key = config.supabaseServiceRoleKey || config.supabaseAnonKey;
  requireSecret('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY', key);

  return createClient(config.supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
