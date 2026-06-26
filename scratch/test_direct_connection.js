import pg from 'pg';
import 'dotenv/config';

const { Client } = pg;
const directUrl = process.env.DATABASE_URL.replace(':6543/', ':5432/').replace('?pgbouncer=true', '');

console.log('Testing direct connection to:', directUrl.replace(/:[^:@]+@/, ':****@'));

const client = new Client({
  connectionString: directUrl,
  ssl: { rejectUnauthorized: false }
});

try {
  await client.connect();
  console.log('Successfully connected to port 5432!');
  const query = `
    select pid, age(clock_timestamp(), query_start), state, query, wait_event_type, wait_event
    from pg_stat_activity
    where state != 'idle' and query not like '%pg_stat_activity%'
    order by query_start desc;
  `;
  const res = await client.query(query);
  console.log('Active queries in pg_stat_activity:');
  console.log(JSON.stringify(res.rows, null, 2));
} catch (err) {
  console.error('Connection failed:', err.message);
} finally {
  await client.end().catch(() => {});
}
