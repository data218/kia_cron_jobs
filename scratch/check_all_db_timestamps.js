import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  // Query all tables in public schema
  const tablesRes = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  console.log('All Base Tables Timestamps (IST):');
  console.log('================================================================================');

  for (const row of tablesRes.rows) {
    const table = row.table_name;
    try {
      // Find standard timestamp columns
      const colRes = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = $1 
          AND column_name IN ('uploaded_at','created_at','fetched_at','inserted_at', 'bill_date', 'ro_date', 'r_o_date', 'complaint_date')
        ORDER BY CASE column_name 
          WHEN 'uploaded_at' THEN 1 
          WHEN 'fetched_at' THEN 2
          WHEN 'created_at' THEN 3 
          WHEN 'inserted_at' THEN 4
          ELSE 5 END
        LIMIT 1
      `, [table]);

      const countRes = await client.query(`SELECT COUNT(*) FROM "${table}"`);
      const rowCount = countRes.rows[0].count;

      if (colRes.rows.length > 0) {
        const col = colRes.rows[0].column_name;
        const tsRes = await client.query(`SELECT MAX("${col}") as latest FROM "${table}"`);
        const latest = tsRes.rows[0].latest;
        
        let istTime = 'N/A';
        if (latest) {
          try {
            istTime = new Date(latest).toLocaleString('en-IN', { 
              timeZone: 'Asia/Kolkata', 
              day: '2-digit', 
              month: 'short', 
              hour: '2-digit', 
              minute: '2-digit', 
              hour12: true 
            });
          } catch (err) {
            istTime = String(latest);
          }
        }
        
        console.log(`${table.padEnd(45)} | rows: ${String(rowCount).padEnd(8)} | latest ${col.padEnd(15)}: ${istTime}`);
      } else {
        console.log(`${table.padEnd(45)} | rows: ${String(rowCount).padEnd(8)} | no timestamp column`);
      }
    } catch (e) {
      console.log(`${table.padEnd(45)} | ERROR: ${e.message}`);
    }
  }
} finally {
  await client.end();
}
