# Recovery Plan: AM Platinum Operation Wise Analysis Report (2021-01-01 → Today)

## Goal
Recover `am_platinum_operation_wise_analysis_report` table data for the **Operation Wise Analysis Report** from **January 2021 through today**, targeting **AM Platinum** brand (dealers: `N5211, N6824, N6828`).

## 1. Pre-flight: Check Table Status

Run the existing check script to determine current state:

```bash
node scripts/check-am-platinum-operation-wise.js
```

**Possible outcomes:**
| Outcome | Action |
|---------|--------|
| Table missing | Proceed to full backfill (no data at all) |
| Table exists with 0 rows | Proceed to full backfill (empty table) |
| Table exists with partial data | Proceed by default (force full fill if needed; both Operation & Part types will be written — duplicates deduplicated by row_hash) |

## 2. Recovery Approach

The project already contains a dedicated recovery script at `scripts/recover-am-platinum-operation-wise.js`. This script is purpose-built for this exact scenario and already:

- Logs into AM Platinum DMS (`loginToHmilDms` with `am-platinum` account profile)
- Switches between each dealer (`N5211`, `N6824`, `N6828`)
- Opens the **Operation Wise Analysis Report** page
- For each month from **2021-01-01 to today** (broken into `getMonthlySafeRanges`):
  - Sets **Report Type** = `Operation` → fills date → searches → exports all pages → saves to `am_platinum_operation_wise_analysis_report`
  - Then sets **Report Type** = `Part` → fills date → searches → exports all pages → saves to `am_platinum_operation_wise_analysis_report`
- Uses `saveReportSheetToRelationalTable` (already used by the in-production code path at `src/reports/operation-wise-analysis-report.js:242-246`)
- Deduplicates via `row_hash` — safe to re-run even if partial data exists

**Total iterations:** ~67 months × 2 report types × 3 dealers = ~402 API calls. At ~30-60 seconds each this is ~3.5–7 hours of runtime.

## 3. Execution Steps

### Step A: Optional — Kill running scheduler to avoid lock conflicts
```powershell
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*scheduler*" } | Stop-Process -ErrorAction SilentlyContinue
```

### Step B: Run the recovery script
```bash
node scripts/recover-am-platinum-operation-wise.js
```

The script:
1. Starts by printing table status (exists? row count? date range?)
2. If data exists and `FORCE_RECOVERY != true` → exits early (user can override)
3. Logs into AM Platinum DMS (session shared across all dealers)
4. Iterates dealer → report type → month
5. Progress indicator: `[67/67] 2023-06-01 to 2023-06-30... ✅ 1250 rows`
6. Prints summary at end

### Step C: Verify
Re-run check:
```bash
node scripts/check-am-platinum-operation-wise.js
```

Expected: all 3 dealers, both report types (Operation + Part), full 2021-01-01 to today coverage.

## 4. Key Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Browser/session dies mid-run | Script catches errors, attempts re-login, continues |
| Month has no data | Counted as `⚠️ No data`, script continues |
| Portal timeout on large date range | Each month = 1 month window; page size 300 is safe |
| Duplicate data on re-run | `row_hash` deduplication — no data corruption |
| Network dropout | `executeWithRetry` wrapper retries each chunk |
| Lock conflict with scheduler | Run outside scheduler hours or kill scheduler first |

## 5. What to Watch During Execution

- **Progress per month:** should complete 1–2 minutes per (dealer × type × month)
- **No rows / ⚠️ months:** months near 2021-01-01 may legitimately have no data
- **Session expiry:** if login fails, the script attempts re-login
- **Final summary:** total rows inserted should be in the range 50k–200k rows depending on dealer volume

## 6. Post-Recovery

- Table `am_platinum_operation_wise_analysis_report` will be populated
- JSON backup in `business_excellence_am_kia_new` will also have entries per save
- Dashboard materialized views can be refreshed via `refreshDashboardMaterializedViews()` if user wants

---

**Ready to execute.** The one-shot command is:

```bash
node scripts/recover-am-platinum-operation-wise.js
```

This will auto-detect table status, run the full Jan-2021-to-today backfill for both Operation & Part types across all 3 AM Platinum dealers, and print a verification summary at the end.
