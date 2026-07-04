import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const resMgt = await client.query(`
    SELECT order_dealer, count(*) 
    FROM public.kia_stock_management 
    GROUP BY order_dealer
  `);
  console.log('kia_stock_management:', resMgt.rows);

  const resRep = await client.query(`
    SELECT order_dealer, count(*) 
    FROM public.kia_stock_report 
    GROUP BY order_dealer
  `);
  console.log('kia_stock_report:', resRep.rows);
} catch (e) {
  console.error(e);
} finally {
  await client.end();
}
