import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const tables = [
    'hyundai_ro_billing_report',
    'hyundai_open_ro_yearly',
    'hyundai_call_center_complaints',
    'hyundai_operation_wise_analysis_report',
    'hyundai_ew_report',
  ];

  for (const table of tables) {
    try {
      // Find timestamp column
      const colRes = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = $1 AND column_name IN ('uploaded_at','created_at','fetched_at','inserted_at')
        ORDER BY CASE column_name 
          WHEN 'uploaded_at' THEN 1 
          WHEN 'fetched_at' THEN 2
          WHEN 'created_at' THEN 3 
          WHEN 'inserted_at' THEN 4
          ELSE 5 END
        LIMIT 1
      `, [table]);

      const countRes = await client.query(`SELECT COUNT(*) FROM ${table}`);

      if (colRes.rows.length > 0) {
        const col = colRes.rows[0].column_name;
        const tsRes = await client.query(`SELECT MAX(${col}) as latest FROM ${table}`);
        const latest = tsRes.rows[0].latest;
        // Convert to IST
        const istTime = latest ? new Date(latest).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:true }) : 'N/A';
        console.log(`${table}:`);
        console.log(`  rows: ${countRes.rows[0].count}`);
        console.log(`  latest ${col} (IST): ${istTime}`);
        console.log(`  latest ${col} (UTC): ${latest}`);
      } else {
        console.log(`${table}: rows=${countRes.rows[0].count}, no standard timestamp column found`);
      }
    } catch (e) {
      console.log(`${table}: ERROR - ${e.message}`);
    }
  }
} finally {
  await client.end();
}
