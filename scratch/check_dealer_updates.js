import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const queries = [
    {
      label: 'AM Platinum Repair Order List by dlr_no',
      sql: `
        SELECT dlr_no, COUNT(*), MAX(uploaded_at) as latest_upload
        FROM am_platinum_repair_order_list
        GROUP BY dlr_no
        ORDER BY dlr_no
      `
    },
    {
      label: 'AM Platinum Customer Complaint List by Dealer',
      sql: `
        SELECT source_dealer_code, COUNT(*), MAX(uploaded_at) as latest_upload
        FROM am_platinum_customer_complaint_list
        GROUP BY source_dealer_code
        ORDER BY source_dealer_code
      `
    },
    {
      label: 'Hyundai Repair Order List by dlr_no',
      sql: `
        SELECT dlr_no, COUNT(*), MAX(uploaded_at) as latest_upload
        FROM hyundai_repair_order_list
        GROUP BY dlr_no
        ORDER BY dlr_no
      `
    }
  ];

  for (const q of queries) {
    console.log(`\n=== ${q.label} ===`);
    try {
      const res = await client.query(q.sql);
      res.rows.forEach(r => {
        const ist = r.latest_upload ? new Date(r.latest_upload).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'N/A';
        console.log(`  Dealer: ${r.dlr_no || r.source_dealer_code} | rows: ${r.count} | latest (IST): ${ist}`);
      });
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }
} finally {
  await client.end();
}
