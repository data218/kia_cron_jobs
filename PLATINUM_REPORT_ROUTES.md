# AM Platinum report routes and Excel replacement map

AM Platinum uses the Hyundai NDMS/GDMS portal. The account changes the active
dealer, then opens the same report routes used by the Hyundai report engine.

## Dealer/login ownership

- `N5211` and `N6828`: historical login (`AM_PLATINUM_HISTORICAL_USER_ID`,
  normally MIS12345).
- Rajouri historical data may be fetched as `N6824`, but it is stored as
  `N6250`.
- Current Rajouri data: current login (`AM_PLATINUM_USER_ID`, normally
  MIS1988), dealer `N6250`.

Every imported workbook must identify its dealer. Prefer a
`source_dealer_code` column in the workbook. If the workbook does not contain
it, the importer must receive the dealer code explicitly.

## Report-to-table mapping

| Report ID | Portal route and report | Important filter | Destination table |
|---|---|---|---|
| `hyundai-repair-order-list` | Service → Repair Order → Repair Order List | RO date range | `am_platinum_repair_order_list` |
| `hyundai-ro-billing-report` | Service MIS → Repair Billing → R/O Billing Report | Bill date range | `am_platinum_ro_billing_report` |
| `hyundai-call-center-complaints` | CRM → Call Center/Complaint → HMI Call Center Complaint Service List | Complaint date range | `am_platinum_call_center_complaints` |
| `hyundai-customer-complaint-list` | CRM → Complaint → Customer Complaint List | Complaint date range; each complaint-source option | `am_platinum_customer_complaint_list` |
| `hyundai-open-ro-yearly` | Service → Repair Order → Repair Order List | RO status = Open; RO date range | `am_platinum_open_ro_yearly` |
| `hyundai-demo-job-cards` | Service → Repair Order → Repair Order List | Work Type = Test Drive/CC Maintenance; RO date range | `am_platinum_demo_job_cards` |
| `hyundai-demo-car-list` | Sales MIS → Monthly Reports → Purchase Report | Purchase/query date range | `am_platinum_demo_car_list` |
| `hyundai-service-appointment` | Service → Service Booking → Service Booking List | Booking/appointment date; cron uses current full month | `am_platinum_service_appointment` |
| `hyundai-trust-package-bodyshop-sot` | Service → TMA Management → Bodyshop - Shield of Trust (Non-insurance repair program) Register List | Registration date range | `am_platinum_trust_package` |
| `hyundai-trust-package-sot-super` | Service → TMA Management → SOT Super Register List | Registration date range | `am_platinum_trust_package` |
| `hyundai-trust-package-package-list` | Service → TMA Management → Hyundai Shield of Trust Package List | Registration date range | `am_platinum_trust_package` |
| `hyundai-psf-yearly` | Service MIS → Customer Followup / Report → Post Service Follow Up Report | RO date range | `am_platinum_psf_yearly` |
| `hyundai-ew-report` | Service MIS → Service Retention Package → Extended Warranty Report | Registration date range | `am_platinum_ew_report` |
| `hyundai-mcp-report` | Service → My Convenience → My Convenience List | Registration date range | `am_platinum_mcp_report` |
| `hyundai-adv-wise-lubricants-vas` | Service MIS → Work Profit → Operation Wise Analysis Report | Date Type = Billing Date; date range | `am_platinum_adv_wise_lubricants_vas` |
| `hyundai-operation-wise-analysis-report` | Service MIS → Work Profit → Operation Wise Analysis Report | Date Type = Billing Date; Report Type = Operation and Part | `am_platinum_operation_wise_analysis_report` |

The three Trust Package exports intentionally share one table. They must carry
one of these exact `trust_package_section` values:

- `Bodyshop - Shield of Trust (Non-insurance repair program) Register List`
- `SOT Super Register List`
- `Hyundai Shield of Trust Package List`

Operation Wise imports must carry:

- `source_dealer_code`
- `report_type` (`Operation` or `Part`)
- `report_month`
- `report_period_start`
- `report_period_end`

Customer Complaint exports should retain the source-filter distinction in
`complaint_source_filter` when multiple portal filter values are combined.

## Safe replacement procedure

Old rows must not be deleted as the first step. For each table:

1. Parse every supplied workbook.
2. Confirm the workbook/report mapping, dealer code, headers, row count, date
   coverage, and required metadata.
3. Load into a temporary staging table inside a database transaction.
4. Compare staged counts, dealer coverage, date minimum/maximum, duplicate
   identities, and invalid date/numeric counts.
5. Create a backup snapshot of the current production table.
6. Replace the production rows from staging.
7. Verify production counts and refresh
   `am_platinum_vas_period_summary_v1`.
8. Commit only when verification succeeds; otherwise roll back.

Do not run the Platinum cron while a replacement transaction is in progress.
After replacement, scheduled cron runs should remain current-month-only using
`AM_PLATINUM_CURRENT_MONTH_ONLY=true`.

## Preferred file naming

Use one file per report and dealer:

```text
<report-id>__<dealer-code>__<start-date>__<end-date>.xlsx
```

Examples:

```text
hyundai-ro-billing-report__N5211__2021-01-01__2026-06-18.xlsx
hyundai-operation-wise-analysis-report-operation__N6250__2024-01-01__2026-06-18.xlsx
hyundai-trust-package-sot-super__N6828__2021-01-01__2026-06-18.xlsx
```

Multiple files for the same report/dealer are acceptable when a large export
is split by month or year.
