# AM Platinum - Quick Fix Action Plan

## 🚨 Critical Issues Found

### Issue 1: NO Historical Data (January 1, 2021 - Today)
- ❌ All database tables contain ONLY recent data (June 5-9, 2026)
- ❌ Historical backfill FAILED on June 9 with "browser closed" error
- ❌ Expected: 5+ years of data from 2021-01-01
- ✅ Configured correctly, but never completed successfully

### Issue 2: Missing Dealer in Historical Config
- ❌ N5211 is configured as an active dealer BUT excluded from historical backfill
- ✅ N5211 still has recent data in tables (most data actually)
- ❌ Future historical imports won't include N5211

### Issue 3: Browser Session Crash During Backfill
- ❌ Playwright browser closed unexpectedly during demo-car-list report
- ❌ Error: "Target page, context or browser has been closed"
- ❌ Likely: Network timeout, OTP expiration, or navigation error

### Issue 4: Missing Table Definitions
- ❌ 4 tables don't exist yet:
  - `am_platinum_customer_complaint_list`
  - `am_platinum_open_ro_yearly`
  - `am_platinum_demo_job_cards`
  - `am_platinum_mcp_report`

---

## ✅ Quick Fixes

### Step 1: Fix Dealer Configuration (2 min)
**File:** `.env` (Line 223)

**Current:**
```
AM_PLATINUM_HISTORICAL_DEALERS=N6824,N6828
```

**Change to:**
```
AM_PLATINUM_HISTORICAL_DEALERS=N5211,N6824,N6828
```

**Why:** Ensures all 3 dealers are included in next historical backfill run

---

### Step 2: Increase Browser Timeouts (3 min)
**File:** `.env` 

**Add/Update these values:**
```
PLAYWRIGHT_ACTION_TIMEOUT_MS=60000
PLAYWRIGHT_NAVIGATION_TIMEOUT_MS=90000
LOGIN_TIMEOUT_MS=90000
```

**Why:** Prevents premature browser closure during network delays

---

### Step 3: Enable Better Error Handling (Recommended)
**File:** `.env`

**Add:**
```
HISTORICAL_BACKFILL_ENABLED=true
AM_PLATINUM_FORCE_LOGIN=false
```

**Why:** 
- Enables historical backfill mode
- Force login off to reuse session when possible

---

### Step 4: Restart Historical Backfill

**Option A - Check if can resume:**
```bash
node scripts/run-am-platinum-historical-backfill.js
```

**Option B - Fresh start (clear state first):**
```bash
# Backup current state
copy logs\am-platinum-historical-backfill-state.json logs\am-platinum-historical-backfill-state.backup.json

# Clear state to start fresh
del logs\am-platinum-historical-backfill-state.json

# Run backfill
node scripts/run-am-platinum-historical-backfill.js
```

---

## 📊 What Should Happen After Fix

**Before Fix:**
- Database: Only June 5-9, 2026 data (82,751 rows)
- Dealers: N5211, N6824, N6828 have recent data only
- Historical: ❌ Missing

**After Fix:**
- Database: Data from Jan 1, 2021 to June 6, 2026
- Dealers: All 3 should have historical + recent data
- Historical: ✅ Complete

---

## 🔍 Verify Data After Backfill

Run this command to check progress:
```bash
node scripts/check-am-platinum-data.js
```

**Expected Output After Fix:**
- Date ranges should show dates from 2021 onwards
- All 3 dealers (N5211, N6824, N6828) in each table
- Multiple months/years of data, not just June 2026

---

## 📝 Current Data Status

### By Dealer
| Dealer | Rows | Status |
|---|---|---|
| **N5211** | 45,462 | Most data, but recent only |
| **N6824** | 25,596 | Limited, recent only |
| **N6828** | 14,377 | Least data, recent only |
| **TOTAL** | **82,751** | **All recent (Jun 5-9, 2026)** |

### Tables Status
| Category | Count |
|---|---|
| Tables with data | 10/14 |
| Tables missing | 4/14 |
| Date range coverage | ❌ 0% (need 2021-2026) |
| Dealer coverage | ⚠️ Mixed (partial per table) |

---

## 🛠️ If Backfill Still Fails

### Check These:

1. **Network Connectivity:**
   ```bash
   ping google.com
   ```
   If fails → Network issue, can't fetch from DMS

2. **Database Connection:**
   ```bash
   node -e "import('dotenv/config'); console.log(process.env.DATABASE_URL)"
   ```
   Should show connection string, not empty

3. **Login Credentials:**
   - Verify `AM_PLATINUM_USER_ID` and `AM_PLATINUM_PASSWORD` in `.env`
   - Test manual login to `https://ndms.hmil.net`

4. **Browser Memory:**
   - Kill any existing playwright processes
   - Check available disk space for downloads

5. **OTP Issues:**
   - Ensure telegram bot/webhook is working
   - May need to handle OTP manually during long backfill

---

## 📅 Timeline

| Step | Time | Notes |
|---|---|---|
| Make config changes | 5 min | Edit .env |
| Restart backfill | Varies | 30min-2hrs depending on data size |
| Verify completion | 5 min | Run check script |
| **TOTAL** | **40min-2.5hrs** | Mostly waiting for backfill to run |

---

## ⚠️ Important Notes

1. **Long Process:** 5+ years of data × 3 dealers × 12 reports = hours of processing
   - Can run overnight
   - May need to restart if network drops

2. **First Time:** Since no historical data exists yet, expect longer runtime
   - Subsequent incremental updates should be faster

3. **Backup:** Always backup state file before clearing it
   - Saved in `logs/am-platinum-historical-backfill-state.json`

4. **Monitor:** Watch the backfill process
   - Check logs periodically
   - Browser window will be active (don't close it)

---

## Questions Answered

**Q: Why is there no historical data?**  
A: Backfill job crashed before completing. Only recent uploads exist.

**Q: Why only 2 dealers in config?**  
A: Configuration mismatch - N5211 should be included.

**Q: What about the missing 4 tables?**  
A: Tables are created automatically on first report upload. They don't exist yet because those reports haven't been successful.

**Q: Can I use the recent data?**  
A: Yes, but it's only 4 days old. Not useful for historical analysis.
