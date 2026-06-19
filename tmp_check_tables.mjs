import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  try {
    const { rows } = await pool.query(`
      SELECT tablename FROM pg_catalog.pg_tables 
      WHERE schemaname = 'public' 
      AND tablename NOT LIKE '\\_%'
      ORDER BY tablename
    `);
    console.log('Public tables:');
    rows.forEach(r => console.log('  -', r.tablename));
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}
main();
