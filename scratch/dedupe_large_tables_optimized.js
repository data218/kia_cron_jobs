import { withPostgresClient, quoteIdentifier } from 'file:///c:/Users/sahil/Downloads/kia_cron_jobs/src/supabase/postgres.js';
import { groupRowsByIdentityHash } from 'file:///c:/Users/sahil/Downloads/kia_cron_jobs/src/supabase/row-identity.js';

const POTENTIAL_IDENTITY_COLS = new Set([
  'source_dealer_code', 'dealer_code', 'dlr_code', 'dlr_cd', 'dealer',
  'r_o_no', 'ro_no', 'bill_no', 'complaint_no', 'sr_no', 'certi_no', 'cert_no', 'certificate_no',
  'vin', 'vin_no', 'chassis_no', 'vin_chassis_no', 'vin_chasis_no',
  'ro_date', 'r_o_date', 'bill_date', 'complaint_date', 'resolving_date',
  'close_date', 'departure_date', 'grn_date', 'order_date', 'hmi_invoice_date',
  'followup_date', 'appointment_date', 'appointment_time', 'booking_done_on',
  'b_t_no', 'a_t_no', 'booking_no', 'appointment_no', 'b_t_date_time',
  'work_type', 'visit_type', 'scheme_desc', 'gst_invoice_no', 'invoice_no',
  'op_part_code', 'labour_code', 'part_no', 'report_type', 'report_month',
  'report_period_start', 'report_period_end', 'claim_no', 'claim_type', 'claim_date',
  'trust_package_section', 'scheme_no', 'reg_date', 'package_purchase_date',
  'package_name', 'service_advisor', 'date_type'
]);

const tablesToDedupe = [
  'hyundai_repair_order_list',
  'hyundai_ro_billing_report',
  'hyundai_service_appointment'
];

const BATCH_SIZE = 500;

await withPostgresClient(async client => {
  for (const table of tablesToDedupe) {
    console.log(`\n--- Optimizing Deduplication for Table: ${table} ---`);

    // Get columns
    const colsResult = await client.query(`
      select column_name 
      from information_schema.columns 
      where table_schema = 'public' 
        and table_name = $1
    `, [table]);
    
    const columns = colsResult.rows.map(r => r.column_name);
    
    // Select columns that are used in identity hashing
    const selectCols = columns.filter(c => POTENTIAL_IDENTITY_COLS.has(c) || ['id', 'row_hash', 'uploaded_at'].includes(c));
    const identityCols = selectCols.filter(c => !['id', 'row_hash', 'uploaded_at'].includes(c));

    console.log(`Querying only ${selectCols.length} columns (out of ${columns.length}): ${selectCols.join(', ')}`);

    const selectQuery = `select ${selectCols.map(quoteIdentifier).join(', ')} from "${table}"`;
    const result = await client.query(selectQuery);
    console.log(`Fetched ${result.rows.length} rows.`);

    // Map rows to group format
    const rows = result.rows.map(row => {
      const data = {};
      for (const col of identityCols) {
        data[col] = row[col];
      }
      return {
        id: row.id,
        row_hash: row.row_hash,
        uploaded_at: row.uploaded_at,
        data
      };
    });

    console.log('Grouping rows by identity hash and sorting...');
    const { rowsToKeep, idsToDelete } = groupRowsByIdentityHash(table, rows);
    console.log(`Deduplication stats:`);
    console.log(`  Rows to keep: ${rowsToKeep.length}`);
    console.log(`  Rows to delete: ${idsToDelete.length}`);

    // 1. Delete duplicates in batches
    if (idsToDelete.length > 0) {
      console.log(`Deleting ${idsToDelete.length} duplicate rows...`);
      for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
        const batch = idsToDelete.slice(i, i + BATCH_SIZE);
        await client.query(`delete from "${table}" where id = any($1::bigint[])`, [batch]);
      }
      console.log('  Deletion completed.');
    }

    // 2. Update final hashes in batches
    const rowsToUpdate = rowsToKeep.filter(r => r.oldHash !== r.newHash);
    console.log(`Updating ${rowsToUpdate.length} final hashes...`);
    if (rowsToUpdate.length > 0) {
      for (let i = 0; i < rowsToUpdate.length; i += BATCH_SIZE) {
        const batch = rowsToUpdate.slice(i, i + BATCH_SIZE);
        await client.query(
          `
            update "${table}" as target
            set row_hash = source.row_hash
            from jsonb_to_recordset($1::jsonb) as source(id bigint, row_hash text)
            where target.id = source.id
          `,
          [JSON.stringify(batch.map(row => ({
            id: row.id,
            row_hash: row.newHash
          })))]
        );
      }
      console.log('  Hash updates completed.');
    }
  }
});

console.log('\nOptimized deduplication completed successfully.');
