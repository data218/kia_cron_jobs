import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres.crreoeautoqzcgtlwlsd:Singh%40%23654321@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
  max: 1,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  // Add unique constraint on items_row (sku, location)
  try {
    await pool.query('ALTER TABLE public.items_row ADD CONSTRAINT items_row_sku_location_unique UNIQUE (sku, location);');
    console.log('✓ items_row unique constraint added');
  } catch (e) {
    if (e.code === '42P16' || e.message.includes('already exists')) {
      console.log('! items_row constraint already exists');
    } else if (e.code === '23505') {
      console.log('✗ items_row has duplicates. Deduplicating...');
      await pool.query(`DELETE FROM public.items_row a USING public.items_row b WHERE a.id > b.id AND a.sku = b.sku AND a.location = b.location`);
      console.log('  Retrying...');
      await pool.query('ALTER TABLE public.items_row ADD CONSTRAINT items_row_sku_location_unique UNIQUE (sku, location);');
      console.log('✓ items_row unique constraint added after dedup');
    } else {
      console.log('✗ items_row error:', e.code, e.message.substring(0, 100));
    }
  }

  // Add unique constraint on consumption_rows (part_no, location, type)
  try {
    await pool.query('ALTER TABLE public.consumption_rows ADD CONSTRAINT consumption_rows_parts_unique UNIQUE (part_no, location, type);');
    console.log('✓ consumption_rows unique constraint added');
  } catch (e) {
    if (e.code === '42P16' || e.message.includes('already exists')) {
      console.log('! consumption_rows constraint already exists');
    } else if (e.code === '23505') {
      console.log('✗ consumption_rows has duplicates. Deduplicating...');
      await pool.query(`DELETE FROM public.consumption_rows a USING public.consumption_rows b WHERE a.id > b.id AND a.part_no = b.part_no AND a.location = b.location AND a.type = b.type`);
      console.log('  Retrying...');
      await pool.query('ALTER TABLE public.consumption_rows ADD CONSTRAINT consumption_rows_parts_unique UNIQUE (part_no, location, type);');
      console.log('✓ consumption_rows unique constraint added after dedup');
    } else {
      console.log('✗ consumption_rows error:', e.code, e.message.substring(0, 100));
    }
  }

  const res = await pool.query(`SELECT conname, conrelid::regclass AS table_name FROM pg_constraint WHERE conname IN ('items_row_sku_location_unique', 'consumption_rows_parts_unique')`);
  res.rows.forEach(r => console.log('Verified:', r.conname, 'on', r.table_name));

  await pool.end();
}

main();
