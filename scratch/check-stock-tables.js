import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  // Check which tables exist
  const tablesRes = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema='public' AND table_name IN ('kia_stock_management','kia_stock_report') 
    ORDER BY table_name
  `);
  console.log('Tables found:', tablesRes.rows.map(r => r.table_name));

  // Count rows in kia_stock_management
  if (tablesRes.rows.some(r => r.table_name === 'kia_stock_management')) {
    const countRes = await client.query('SELECT COUNT(*) FROM kia_stock_management');
    console.log('kia_stock_management rows:', countRes.rows[0].count);
  }

  // Count rows in kia_stock_report if exists
  if (tablesRes.rows.some(r => r.table_name === 'kia_stock_report')) {
    const countRes = await client.query('SELECT COUNT(*) FROM kia_stock_report');
    console.log('kia_stock_report rows:', countRes.rows[0].count);
  }
} finally {
  await client.end();
}
