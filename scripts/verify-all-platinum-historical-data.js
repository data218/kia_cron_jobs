import { withPostgresClient } from '../src/supabase/postgres.js';

const platinumTables = [
  'am_platinum_repair_order_list',
  'am_platinum_ro_billing_report',
  'am_platinum_call_center_complaints',
  'am_platinum_demo_car_list',
  'am_platinum_service_appointment',
  'am_platinum_trust_package',
  'am_platinum_psf_yearly',
  'am_platinum_ew_report',
  'am_platinum_adv_wise_lubricants_vas',
  'am_platinum_operation_wise_analysis_report',
  'am_platinum_operation_wise_analysis_advisor_report',
];

const dealers = ['N5211', 'N6250', 'N6828'];

async function analyzeTable(client, tableName) {
  console.log(`\nAnalyzing ${tableName}...`);
  
  try {
    // Get total count
    const countResult = await client.query(`SELECT COUNT(*)::int as cnt FROM "${tableName}"`);
    const totalCount = countResult.rows[0].cnt;

    if (totalCount === 0) {
      console.log(`  No data in table`);
      return { tableName, totalRows: 0, dealers: {}, dateRange: 'N/A' };
    }

    // Get dealer breakdown
    const dealerResult = await client.query(`
      SELECT source_dealer_code, COUNT(*)::int as cnt
      FROM "${tableName}"
      GROUP BY source_dealer_code
      ORDER BY source_dealer_code
    `);

    const dealerCounts = {};
    for (const dealer of dealers) {
      dealerCounts[dealer] = 0;
    }
    
    for (const row of dealerResult.rows) {
      dealerCounts[row.source_dealer_code] = row.cnt;
    }

    // Try to find date range
    let dateRange = 'N/A';
    
    // Check common date column names
    const dateColumns = ['report_month', 'date', 'created_at', 'updated_at', 'billing_date', 'service_date'];
    
    for (const dateCol of dateColumns) {
      try {
        const dateCheck = await client.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = $1 AND column_name = $2
        `, [tableName, dateCol]);
        
        if (dateCheck.rows.length > 0) {
          const rangeResult = await client.query(`
            SELECT MIN("${dateCol}")::text as min_date, MAX("${dateCol}")::text as max_date
            FROM "${tableName}"
          `);
          
          const minDate = rangeResult.rows[0].min_date;
          const maxDate = rangeResult.rows[0].max_date;
          
          if (minDate && maxDate) {
            dateRange = `${minDate.substring(0, 10)} to ${maxDate.substring(0, 10)}`;
            break;
          }
        }
      } catch (e) {
        // Column doesn't exist, continue
      }
    }

    console.log(`  Total rows: ${totalCount}`);
    console.log(`  Date range: ${dateRange}`);
    console.log(`  Dealer breakdown:`);
    for (const dealer of dealers) {
      const count = dealerCounts[dealer] || 0;
      console.log(`    ${dealer}: ${count} rows`);
    }

    return {
      tableName,
      totalRows: totalCount,
      dateRange,
      dealers: dealerCounts
    };
  } catch (error) {
    console.error(`  Error analyzing table: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('\n========================================');
  console.log('COMPREHENSIVE AM PLATINUM DATA VERIFICATION');
  console.log('========================================\n');

  await withPostgresClient(async (client) => {
    const results = [];
    
    for (const tableName of platinumTables) {
      const result = await analyzeTable(client, tableName);
      if (result) results.push(result);
    }

    console.log('\n\n========== SUMMARY TABLE ==========\n');
    console.log('Table Name                               | Total | N5211 | N6250 | N6828 | Date Range');
    console.log('-'.repeat(110));
    
    let totalRowsAll = 0;
    const dealerTotals = { N5211: 0, N6250: 0, N6828: 0 };
    
    for (const result of results) {
      const n5211 = result.dealers.N5211 || 0;
      const n6250 = result.dealers.N6250 || 0;
      const n6828 = result.dealers.N6828 || 0;
      
      dealerTotals.N5211 += n5211;
      dealerTotals.N6250 += n6250;
      dealerTotals.N6828 += n6828;
      totalRowsAll += result.totalRows;
      
      const tableName = result.tableName.padEnd(40);
      const totalStr = String(result.totalRows).padStart(5);
      const n5211Str = String(n5211).padStart(5);
      const n6250Str = String(n6250).padStart(5);
      const n6828Str = String(n6828).padStart(5);
      const dateStr = result.dateRange.padEnd(20);
      
      console.log(`${tableName} | ${totalStr} | ${n5211Str} | ${n6250Str} | ${n6828Str} | ${dateStr}`);
    }
    
    console.log('-'.repeat(110));
    const tableName = 'TOTALS'.padEnd(40);
    const totalStr = String(totalRowsAll).padStart(5);
    const n5211Str = String(dealerTotals.N5211).padStart(5);
    const n6250Str = String(dealerTotals.N6250).padStart(5);
    const n6828Str = String(dealerTotals.N6828).padStart(5);
    console.log(`${tableName} | ${totalStr} | ${n5211Str} | ${n6250Str} | ${n6828Str}`);
    
    console.log('\n\n========== ANALYSIS ==========\n');
    
    // Check N5211
    if (dealerTotals.N5211 > 0) {
      const currentMonthEstimate = dealerTotals.N5211 / platinumTables.length;
      console.log(`N5211: ${dealerTotals.N5211} total rows (~${Math.round(currentMonthEstimate)} per table avg)`);
      console.log(`Status: CURRENT MONTH ONLY - Never backfilled for historical 2021-2026`);
      console.log(`Action: NEEDS HISTORICAL BACKFILL if you want 2021-2026 data\n`);
    } else {
      console.log(`N5211: NO DATA\n`);
    }
    
    // Check N6250 (Rajouri)
    if (dealerTotals.N6250 > 0) {
      const avgPerTable = dealerTotals.N6250 / platinumTables.length;
      if (avgPerTable > 100) {
        console.log(`N6250: ${dealerTotals.N6250} total rows (~${Math.round(avgPerTable)} per table avg)`);
        console.log(`Status: APPEARS TO HAVE HISTORICAL DATA`);
        console.log(`Action: BACKFILL COMPLETE - No action needed\n`);
      } else {
        console.log(`N6250: ${dealerTotals.N6250} total rows (~${Math.round(avgPerTable)} per table avg)`);
        console.log(`Status: LOW ROW COUNT - Likely missing historical data`);
        console.log(`Action: NEEDS HISTORICAL BACKFILL\n`);
      }
    } else {
      console.log(`N6250: NO DATA`);
      console.log(`Status: Never backfilled`);
      console.log(`Action: NEEDS HISTORICAL BACKFILL\n`);
    }
    
    // Check N6828
    if (dealerTotals.N6828 > 0) {
      const avgPerTable = dealerTotals.N6828 / platinumTables.length;
      if (avgPerTable > 100) {
        console.log(`N6828: ${dealerTotals.N6828} total rows (~${Math.round(avgPerTable)} per table avg)`);
        console.log(`Status: APPEARS TO HAVE HISTORICAL DATA`);
        console.log(`Action: BACKFILL COMPLETE - No action needed\n`);
      } else {
        console.log(`N6828: ${dealerTotals.N6828} total rows (~${Math.round(avgPerTable)} per table avg)`);
        console.log(`Status: LOW ROW COUNT - Likely missing historical data`);
        console.log(`Action: NEEDS HISTORICAL BACKFILL\n`);
      }
    } else {
      console.log(`N6828: NO DATA`);
      console.log(`Status: Never backfilled`);
      console.log(`Action: NEEDS HISTORICAL BACKFILL\n`);
    }
    
    console.log('\n========== RECOMMENDATION ==========\n');
    const needsBackfill = [];
    if (dealerTotals.N5211 < platinumTables.length * 50) needsBackfill.push('N5211');
    if (dealerTotals.N6250 < platinumTables.length * 50) needsBackfill.push('N6250');
    if (dealerTotals.N6828 < platinumTables.length * 50) needsBackfill.push('N6828');
    
    if (needsBackfill.length > 0) {
      console.log(`Run historical backfill for: ${needsBackfill.join(', ')}`);
      console.log(`Date range: 2021-01-01 to 2026-06-09\n`);
    } else {
      console.log(`All dealers appear to have historical data. No backfill needed.\n`);
    }
  });
}

main().catch(console.error);
