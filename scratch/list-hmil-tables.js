import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const r = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema='public' AND (table_name LIKE '%hmil%' OR table_name LIKE '%hyundai%') 
    ORDER BY table_name
  `);
  console.log('HMIL/Hyundai tables:');
  r.rows.forEach(x => console.log(' -', x.table_name));
} finally {
  await client.end();
}
