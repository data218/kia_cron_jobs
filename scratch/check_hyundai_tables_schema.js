import { withPostgresClient } from '../src/supabase/postgres.js';

try {
  await withPostgresClient(async client => {
    const tables = ['hyundai_operation_wise_analysis_report', 'hyundai_repair_order_list', 'hyundai_ro_billing_report'];
    
    for (const table of tables) {
      console.log(`\n--- Schema info for: ${table} ---`);
      
      // Check columns
      const colsRes = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
      `, [table]);
      console.log('Columns:');
      colsRes.rows.forEach(r => console.log(`  - ${r.column_name} (${r.data_type})`));
      
      // Check constraints
      const constRes = await client.query(`
        SELECT conname, pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        JOIN pg_class cl ON cl.oid = c.conrelid
        WHERE n.nspname = 'public' AND cl.relname = $1
      `, [table]);
      console.log('Constraints:');
      constRes.rows.forEach(r => console.log(`  - ${r.conname}: ${r.def}`));
    }
  });
} catch (error) {
  console.error('❌ Error:', error.message);
}
