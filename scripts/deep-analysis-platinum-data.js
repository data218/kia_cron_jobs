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
];

const dealers = ['N5211', 'N6824', 'N6828'];

async function deepAnalyzeTable(client, tableName) {
  console.log(`\n${'='.repeat(100)}`);
  console.log(`TABLE: ${tableName}`);
  console.log(`${'='.repeat(100)}`);
  
  try {
    // Get total count and dealer breakdown
    const countResult = await client.query(`
      SELECT source_dealer_code, COUNT(*)::int as cnt
      FROM "${tableName}"
      GROUP BY source_dealer_code
      ORDER BY source_dealer_code
    `);

    if (countResult.rows.length === 0) {
      console.log(`NO DATA\n`);
      return { tableName, totalRows: 0, dealers: {}, hasHistoricalData: false };
    }

    const dealerCounts = {};
    for (const dealer of dealers) {
      dealerCounts[dealer] = 0;
    }
    
    for (const row of countResult.rows) {
      dealerCounts[row.source_dealer_code] = row.cnt;
    }

    const totalRows = countResult.rows.reduce((sum, r) => sum + r.cnt, 0);

    // Find all date columns in the table
    const columnResult = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns 
      WHERE table_name = $1
      AND (data_type = 'date' OR data_type like '%timestamp%')
      ORDER BY column_name
    `, [tableName]);

    const dateColumns = columnResult.rows.map(r => r.column_name);
    
    console.log(`Total rows: ${totalRows}`);
    console.log(`Dealer breakdown:`);
    for (const dealer of dealers) {
      console.log(`  ${dealer}: ${dealerCounts[dealer] || 0} rows`);
    }
    
    console.log(`\nDate columns found: ${dateColumns.length}`);
    if (dateColumns.length === 0) {
      console.log(`  ⚠️  No date columns detected - cannot verify historical data\n`);
      return { 
        tableName, 
        totalRows, 
        dealers: dealerCounts, 
        hasHistoricalData: null,
        dateColumns: []
      };
    }

    console.log(`  ${dateColumns.join(', ')}\n`);

    // Analyze each date column
    let overallHasHistorical = false;
    const dateAnalysis = {};

    for (const dateCol of dateColumns) {
      console.log(`\n  📅 Analyzing "${dateCol}":`);
      
      const dateRangeResult = await client.query(`
        SELECT 
          MIN("${dateCol}")::text as min_date, 
          MAX("${dateCol}")::text as max_date,
          COUNT(*)::int as total_rows
        FROM "${tableName}"
        WHERE "${dateCol}" IS NOT NULL
      `);

      const minDate = dateRangeResult.rows[0].min_date;
      const maxDate = dateRangeResult.rows[0].max_date;
      const nonNullRows = dateRangeResult.rows[0].total_rows;

      if (!minDate || !maxDate) {
        console.log(`    No date values`);
        continue;
      }

      const minYear = minDate.substring(0, 4);
      const maxYear = maxDate.substring(0, 4);

      console.log(`    Min date: ${minDate}`);
      console.log(`    Max date: ${maxDate}`);
      console.log(`    Rows with dates: ${nonNullRows}/${totalRows}`);

      // Check if data spans 2+ years (indicating historical)
      if (parseInt(maxYear) - parseInt(minYear) >= 1) {
        console.log(`    ✅ HAS HISTORICAL DATA (${minYear} to ${maxYear})`);
        overallHasHistorical = true;
      } else if (minYear === maxYear) {
        const minMonth = parseInt(minDate.substring(5, 7));
        const maxMonth = parseInt(maxDate.substring(5, 7));
        if (maxMonth - minMonth >= 2) {
          console.log(`    ⚠️  Current year only (${minYear}, ${minMonth} to ${maxMonth})`);
        } else {
          console.log(`    ❌ CURRENT MONTH ONLY (${minDate.substring(0, 7)})`);
        }
      }

      // Year-by-year breakdown
      const yearBreakdown = await client.query(`
        SELECT 
          EXTRACT(YEAR FROM "${dateCol}")::int as year,
          COUNT(*)::int as year_rows
        FROM "${tableName}"
        WHERE "${dateCol}" IS NOT NULL
        GROUP BY EXTRACT(YEAR FROM "${dateCol}")
        ORDER BY year DESC
      `);

      if (yearBreakdown.rows.length > 0) {
        console.log(`\n    Year breakdown:`);
        for (const row of yearBreakdown.rows) {
          console.log(`      ${row.year}: ${row.year_rows} rows`);
        }
      }

      dateAnalysis[dateCol] = {
        minDate,
        maxDate,
        hasHistorical: overallHasHistorical,
        yearBreakdown: yearBreakdown.rows
      };
    }

    return {
      tableName,
      totalRows,
      dealers: dealerCounts,
      dateColumns,
      dateAnalysis,
      hasHistoricalData: overallHasHistorical
    };

  } catch (error) {
    console.error(`❌ Error analyzing table: ${error.message}\n`);
    return null;
  }
}

async function main() {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              DEEP ANALYSIS: AM PLATINUM HISTORICAL DATA VERIFICATION                                  ║');
  console.log('║              (Checking actual DATE RANGES in all tables)                                              ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════════════════════════════╝');

  await withPostgresClient(async (client) => {
    const results = [];
    
    for (const tableName of platinumTables) {
      const result = await deepAnalyzeTable(client, tableName);
      if (result) results.push(result);
    }

    console.log('\n\n');
    console.log('╔════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                    SUMMARY REPORT                                                    ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════════════════════════════════╝\n');

    console.log('Table Name                               | Total | N5211 | N6824 | N6828 | Has Historical Data?');
    console.log('-'.repeat(110));

    const historicalTables = [];
    const currentMonthTables = [];
    const incompleteDataTables = [];

    for (const result of results) {
      const n5211 = result.dealers.N5211 || 0;
      const n6824 = result.dealers.N6824 || 0;
      const n6828 = result.dealers.N6828 || 0;
      
      const status = result.hasHistoricalData === null ? '?' : result.hasHistoricalData ? '✅ YES' : '❌ NO';
      
      if (result.hasHistoricalData) {
        historicalTables.push(result.tableName);
      } else if (result.hasHistoricalData === false) {
        currentMonthTables.push(result.tableName);
      } else {
        incompleteDataTables.push(result.tableName);
      }
      
      const tableName = result.tableName.padEnd(40);
      const totalStr = String(result.totalRows).padStart(5);
      const n5211Str = String(n5211).padStart(5);
      const n6824Str = String(n6824).padStart(5);
      const n6828Str = String(n6828).padStart(5);
      
      console.log(`${tableName} | ${totalStr} | ${n5211Str} | ${n6824Str} | ${n6828Str} | ${status}`);
    }

    console.log('-'.repeat(110));

    console.log('\n\n📊 CLASSIFICATION:\n');
    
    if (historicalTables.length > 0) {
      console.log(`✅ TABLES WITH HISTORICAL DATA (2021-2026):`);
      for (const table of historicalTables) {
        console.log(`   - ${table}`);
      }
    }

    if (currentMonthTables.length > 0) {
      console.log(`\n❌ TABLES WITH CURRENT MONTH ONLY (NO HISTORICAL):`);
      for (const table of currentMonthTables) {
        console.log(`   - ${table}`);
      }
    }

    if (incompleteDataTables.length > 0) {
      console.log(`\n❓ TABLES WITH UNKNOWN STATUS (No date columns):`);
      for (const table of incompleteDataTables) {
        console.log(`   - ${table}`);
      }
    }

    console.log('\n\n🔍 RECOMMENDATIONS:\n');

    if (currentMonthTables.length > 0) {
      console.log(`⚠️  The following tables DO NOT have historical data and should be re-backfilled:`);
      for (const table of currentMonthTables) {
        console.log(`   - ${table}`);
      }
      console.log(`\n   Action: These tables need to be included in the next historical backfill run.`);
    } else {
      console.log(`✅ All tables with date information appear to have historical data.`);
    }

  });
}

main().catch(console.error);
