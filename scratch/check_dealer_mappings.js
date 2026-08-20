import { withPostgresClient } from '../src/supabase/postgres.js';

await withPostgresClient(async client => {
  const result = await client.query("SELECT * FROM public.hyundai_warranty_dealer_mappings");
  console.log(JSON.stringify(result.rows, null, 2));
});
