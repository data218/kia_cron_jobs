# AM Platinum Manual Export Runner - Instructions

## What This Script Does

This script will:

1. **Login** to AM Platinum system once
2. **For each dealer** (N5211, N6824, N6828):
   - Run **Adv. wise lubricants & VAS** report
   - Run **Operation Wise Analysis Report**
3. **For each report**:
   - Set start date to **January 1, 2021**
   - Set end date to **today** 
   - Set page size to **1000** (instead of default 50)
   - **Skip the search button** - data loads automatically with full 5-year range
   - Export all pages (page by page)
   - Merge pages into single dataset
   - Upload to Supabase database

## How It Works (Your Approach)

**Your optimization approach:**
- ❌ Don't use search button (it's for filtering)
- ✅ Set date range: 2021-01-01 to today
- ✅ Set page size to 1000
- ✅ Wait for data to load automatically
- ✅ Export all loaded data page-by-page

**Why this works:**
- Grid loads all matching data when you set page size without filtering
- Page size of 1000 means fewer page exports (more efficient)
- No search button means grid renders all data automatically

## Timeline

- **Adv. wise lubricants report**: Each dealer ~5-10 minutes (lots of data from 5 years)
- **Operation Wise Analysis report**: Each dealer ~5-10 minutes
- **Total time**: 2 dealers × 2 reports × ~10 min = ~40 minutes per dealer
- **All 3 dealers**: ~2-3 hours total

## Run The Script

```bash
node scripts/run-am-platinum-manual-export.js
```

**During execution:**
- Browser window will open and show the process
- Don't close the browser
- Don't interact with the page
- Watch the console for progress
- Each report shows: rows exported, pages, database action

## Expected Output

```
=== AM PLATINUM MANUAL EXPORT - NO SEARCH BUTTON APPROACH ===
Start Date: 2021-01-01
End Date: [Today's Date]
Page Size: 1000
Reports: Adv. wise lubricants & VAS, Operation Wise Analysis Report
Dealers: N5211, N6824, N6828

✅ Adv. wise lubricants & VAS - N5211: 150000 rows (150 pages)
✅ Operation Wise Analysis Report - N5211: 200000 rows (200 pages)
✅ Adv. wise lubricants & VAS - N6824: 80000 rows (80 pages)
✅ Operation Wise Analysis Report - N6824: 100000 rows (100 pages)
✅ Adv. wise lubricants & VAS - N6828: 60000 rows (60 pages)
✅ Operation Wise Analysis Report - N6828: 75000 rows (75 pages)

Total: 6/6 completed successfully
```

## After Running

**Verify data was uploaded:**
```bash
node scripts/check-am-platinum-data.js
```

You should see:
- `am_platinum_adv_wise_lubricants_vas`: Now has data from 2021-2026 for all 3 dealers
- `am_platinum_operation_wise_analysis_report`: Now has data from 2021-2026 for all 3 dealers

## Troubleshooting

### Script fails with "browser closed" error
- May be network timeout
- Increase timeout in script (currently 600000ms = 10min)
- Can restart; state is saved

### No data exported
- Check if dealers have data in the system
- Try one dealer manually to verify
- Check network connection

### Takes too long
- 5 years of data × 3 dealers × 2 reports = Large dataset
- Normal to take 2-3 hours
- Can pause and restart (state is preserved)

### Database upload fails
- Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
- Check database connectivity
- Check if tables exist (they're created automatically)

## Next Steps After Completion

1. Run check script to verify data:
   ```bash
   node scripts/check-am-platinum-data.js
   ```

2. Your cron jobs can now use this data for reports

3. Consider running incremental exports monthly instead of full backfill

## Notes

- **Dealer N5211**: Expected to have most data (it's primary dealer)
- **Dealers N6824, N6828**: Expected to have moderate data
- **Date range**: 2021-01-01 to today covers all historical + recent data
- **Page size 1000**: Balances export speed vs page count (fewer pages = faster)
