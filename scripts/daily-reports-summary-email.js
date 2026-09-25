import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { config } from '../src/config.js';
import { withPostgresClient } from '../src/supabase/postgres.js';
import { logger } from '../src/utils/logger.js';

export const MONITORED_REPORTS = [
  // KIA REPORTS
  { brand: 'Kia', reportName: 'Kia Sales Report', table: 'kia_sales_report', schedule: 'Daily 18:50' },
  { brand: 'Kia', reportName: 'Kia Booking Report', table: 'kia_booking_report', schedule: 'Daily 18:50' },
  { brand: 'Kia', reportName: 'Kia Enquiry Report', table: 'kia_enquiry_report', schedule: 'Daily 18:50' },
  { brand: 'Kia', reportName: 'Kia Purchase Report', table: 'kia_purchase_report', schedule: 'Daily 19:20' },
  { brand: 'Kia', reportName: 'Kia Receipt Report', table: 'kia_receipt_report', schedule: 'Daily 19:25' },
  { brand: 'Kia', reportName: 'Kia Stock Management', table: 'kia_stock_management', schedule: 'Hourly 10-18' },
  { brand: 'Kia', reportName: 'Kia Stock Report', table: 'kia_stock_report', schedule: 'Daily' },
  { brand: 'Kia', reportName: 'Kia R/O Billing Report', table: 'ro_billing_report', schedule: 'Hourly 09-18' },
  { brand: 'Kia', reportName: 'Kia Service Appointment', table: 'service_appointment', schedule: 'Daily 18:45' },
  { brand: 'Kia', reportName: 'Kia Claims Management', table: 'kia_calim_management', schedule: 'Daily 19:30' },
  { brand: 'Kia', reportName: 'Kia Call Center Complaints', table: 'kia_call_center_complaints', schedule: 'Daily 18:25' },
  { brand: 'Kia', reportName: 'Kia Open RO Yearly', table: 'open_ro_yearly', schedule: 'Daily 18:10' },
  { brand: 'Kia', reportName: 'Kia PSF Yearly', table: 'psf_yearly', schedule: 'Daily' },
  { brand: 'Kia', reportName: 'Kia Extended Warranty', table: 'ew_report', schedule: 'Daily' },
  { brand: 'Kia', reportName: 'Kia MCP Report', table: 'mcp_report', schedule: 'Daily' },
  { brand: 'Kia', reportName: 'Kia Demo Job Cards', table: 'demo_job_cards', schedule: 'Daily 10:30, 18:30' },
  { brand: 'Kia', reportName: 'Kia Demo Car List', table: 'demo_car_list', schedule: 'Weekly Mon 15:30' },
  { brand: 'Kia', reportName: 'Kia Lubricants & VAS', table: 'adv_wise_lubricants_vas', schedule: 'Daily' },
  { brand: 'Kia', reportName: 'Kia Operation Wise Analysis', table: 'operation_wise_analysis_report', schedule: 'Daily' },
  { brand: 'Kia', reportName: 'Kia RSA Report', table: 'rsa_report', schedule: 'Daily 10:05' },

  // HYUNDAI REPORTS
  { brand: 'Hyundai', reportName: 'Hyundai Sales Report', table: 'hyundai_sales_report', schedule: 'Daily 18:30' },
  { brand: 'Hyundai', reportName: 'Hyundai Booking Report', table: 'hyundai_booking_report', schedule: 'Daily 18:30' },
  { brand: 'Hyundai', reportName: 'Hyundai Enquiry Report', table: 'hyundai_enquiry_report', schedule: 'Daily 18:30' },
  { brand: 'Hyundai', reportName: 'Hyundai Purchase Report', table: 'hyundai_purchase_report', schedule: 'Daily 19:00' },
  { brand: 'Hyundai', reportName: 'Hyundai Receipt Report', table: 'hyundai_receipt_report', schedule: 'Daily 19:00' },
  { brand: 'Hyundai', reportName: 'Hyundai R/O Billing Report', table: 'hyundai_ro_billing_report', schedule: 'Hourly 09-18' },
  { brand: 'Hyundai', reportName: 'Hyundai Service Appointment', table: 'hyundai_service_appointment', schedule: 'Daily 18:30' },
  { brand: 'Hyundai', reportName: 'Hyundai Repair Order List', table: 'hyundai_repair_order_list', schedule: 'Daily 16:20' },
  { brand: 'Hyundai', reportName: 'Hyundai Open RO Yearly', table: 'hyundai_open_ro_yearly', schedule: 'Daily 18:00' },
  { brand: 'Hyundai', reportName: 'Hyundai PSF Yearly', table: 'hyundai_psf_yearly', schedule: 'Daily' },
  { brand: 'Hyundai', reportName: 'Hyundai Extended Warranty', table: 'hyundai_ew_report', schedule: 'Daily' },
  { brand: 'Hyundai', reportName: 'Hyundai MCP Report', table: 'hyundai_mcp_report', schedule: 'Daily' },
  { brand: 'Hyundai', reportName: 'Hyundai Lubricants & VAS', table: 'hyundai_adv_wise_lubricants_vas', schedule: 'Daily' },
  { brand: 'Hyundai', reportName: 'Hyundai Operation Wise Analysis', table: 'hyundai_operation_wise_analysis_report', schedule: 'Daily' },
  { brand: 'Hyundai', reportName: 'Hyundai Call Center Complaints', table: 'hyundai_call_center_complaints', schedule: 'Daily' },
  { brand: 'Hyundai', reportName: 'Hyundai Customer Complaint List', table: 'hyundai_customer_complaint_list', schedule: 'Daily' },
  { brand: 'Hyundai', reportName: 'Hyundai Demo Job Cards', table: 'hyundai_demo_job_cards', schedule: 'Daily' },
  { brand: 'Hyundai', reportName: 'Hyundai Demo Car List', table: 'hyundai_demo_car_list', schedule: 'Weekly' },
  { brand: 'Hyundai', reportName: 'Hyundai Insurance Policy Summary', table: 'hyundai_insurance_policy_summary', schedule: 'Daily 19:00' },
  { brand: 'Hyundai', reportName: 'Hyundai Warranty Claim List', table: 'hyundai_warranty_claim_list', schedule: 'Daily 20:00' },
  { brand: 'Hyundai', reportName: 'Hyundai Warranty Claim YTP', table: 'hyundai_warranty_claim_ytp', schedule: 'Daily 20:00' },

  // AM PLATINUM REPORTS
  { brand: 'AM Platinum', reportName: 'Platinum Sales Report', table: 'am_platinum_sales_report', schedule: 'Daily 18:30' },
  { brand: 'AM Platinum', reportName: 'Platinum Booking Report', table: 'am_platinum_booking_report', schedule: 'Daily 18:30' },
  { brand: 'AM Platinum', reportName: 'Platinum Enquiry Report', table: 'am_platinum_enquiry_report', schedule: 'Daily 18:30' },
  { brand: 'AM Platinum', reportName: 'Platinum Purchase Report', table: 'am_platinum_purchase_report', schedule: 'Daily 19:00' },
  { brand: 'AM Platinum', reportName: 'Platinum Receipt Report', table: 'am_platinum_receipt_report', schedule: 'Daily 19:00' },
  { brand: 'AM Platinum', reportName: 'Platinum Repair Order List', table: 'am_platinum_repair_order_list', schedule: 'Daily 16:20' },
  { brand: 'AM Platinum', reportName: 'Platinum R/O Billing Report', table: 'am_platinum_ro_billing_report', schedule: 'Hourly 09-18' },
  { brand: 'AM Platinum', reportName: 'Platinum Service Appointment', table: 'am_platinum_service_appointment', schedule: 'Daily 18:30' },
  { brand: 'AM Platinum', reportName: 'Platinum Open RO Yearly', table: 'am_platinum_open_ro_yearly', schedule: 'Daily 18:00' },
  { brand: 'AM Platinum', reportName: 'Platinum PSF Yearly', table: 'am_platinum_psf_yearly', schedule: 'Daily' },
  { brand: 'AM Platinum', reportName: 'Platinum Extended Warranty', table: 'am_platinum_ew_report', schedule: 'Daily' },
  { brand: 'AM Platinum', reportName: 'Platinum MCP Report', table: 'am_platinum_mcp_report', schedule: 'Daily' },
  { brand: 'AM Platinum', reportName: 'Platinum Lubricants & VAS', table: 'am_platinum_adv_wise_lubricants_vas', schedule: 'Daily' },
  { brand: 'AM Platinum', reportName: 'Platinum Operation Wise Analysis', table: 'am_platinum_operation_wise_analysis_report', schedule: 'Daily' },
  { brand: 'AM Platinum', reportName: 'Platinum Call Center Complaints', table: 'am_platinum_call_center_complaints', schedule: 'Daily' },
  { brand: 'AM Platinum', reportName: 'Platinum Customer Complaint List', table: 'am_platinum_customer_complaint_list', schedule: 'Daily' },
  { brand: 'AM Platinum', reportName: 'Platinum Demo Job Cards', table: 'am_platinum_demo_job_cards', schedule: 'Daily' },
  { brand: 'AM Platinum', reportName: 'Platinum Demo Car List', table: 'am_platinum_demo_car_list', schedule: 'Weekly' },
  { brand: 'AM Platinum', reportName: 'Platinum Insurance Policy Summary', table: 'am_platinum_insurance_policy_summary', schedule: 'Daily 19:00' }
];

function formatIstDateTime(date) {
  if (!date) return 'Never / Unknown';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date(date));
}

function formatIstDateOnly(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(date);
}

export async function collectDailyReportStatus() {
  return withPostgresClient(async client => {
    const todayStartIso = new Date();
    todayStartIso.setHours(0, 0, 0, 0);

    // Get today's start in IST (UTC+5:30)
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const istTodayMidnightUtc = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0) - istOffset);

    const results = [];

    for (const report of MONITORED_REPORTS) {
      try {
        const tableCheck = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1;`,
          [report.table]
        );

        if (!tableCheck.rowCount) {
          results.push({
            ...report,
            status: 'TABLE_MISSING',
            success: false,
            lastUpload: null,
            rowsToday: 0,
            totalRows: 0,
            error: 'Table does not exist in database'
          });
          continue;
        }

        const statsQuery = await client.query(`
          SELECT 
            count(*) as total_rows,
            count(*) FILTER (WHERE uploaded_at >= $1) as rows_today,
            max(uploaded_at) as last_uploaded_at
          FROM public."${report.table}";
        `, [istTodayMidnightUtc.toISOString()]);

        const totalRows = Number(statsQuery.rows[0]?.total_rows ?? 0);
        const rowsToday = Number(statsQuery.rows[0]?.rows_today ?? 0);
        const lastUploadedAt = statsQuery.rows[0]?.last_uploaded_at ? new Date(statsQuery.rows[0].last_uploaded_at) : null;

        const isUpdatedToday = lastUploadedAt && lastUploadedAt >= istTodayMidnightUtc;

        // Weekly reports (like demo car list) are expected only on Mondays
        const isWeekly = report.schedule.toLowerCase().includes('weekly');
        const isMonday = istNow.getUTCDay() === 1;

        let success = isUpdatedToday;
        if (isWeekly && !isMonday) {
          success = true; // Not required to update today if not scheduled today
        }

        results.push({
          ...report,
          status: success ? 'OK' : 'FAILED_OR_NOT_UPDATED',
          success,
          lastUpload: lastUploadedAt,
          rowsToday,
          totalRows,
          error: success ? null : 'No data uploaded or modified today'
        });
      } catch (err) {
        results.push({
          ...report,
          status: 'QUERY_ERROR',
          success: false,
          lastUpload: null,
          rowsToday: 0,
          totalRows: 0,
          error: err.message
        });
      }
    }

    return results;
  });
}

export function buildEmailHtml(reportStatuses, generatedAt = new Date()) {
  const failedReports = reportStatuses.filter(r => !r.success);
  const successReports = reportStatuses.filter(r => r.success);
  const dateStr = formatIstDateOnly(generatedAt);

  const totalCount = reportStatuses.length;
  const failedCount = failedReports.length;
  const successCount = successReports.length;

  const statusColor = failedCount === 0 ? '#10b981' : '#ef4444';
  const statusBadge = failedCount === 0 ? 'ALL SYSTEMS NORMAL' : `${failedCount} REPORT(S) REQUIRE ATTENTION`;

  const failedRowsHtml = failedReports.map(r => `
    <tr style="border-bottom: 1px solid #fee2e2; background-color: #fef2f2;">
      <td style="padding: 10px 12px; font-weight: bold; color: #b91c1c;">${r.brand}</td>
      <td style="padding: 10px 12px; font-weight: 600; color: #1f2937;">${r.reportName}</td>
      <td style="padding: 10px 12px; font-family: monospace; color: #4b5563;">${r.table}</td>
      <td style="padding: 10px 12px; color: #6b7280;">${r.schedule}</td>
      <td style="padding: 10px 12px; color: #dc2626; font-size: 12px;">${formatIstDateTime(r.lastUpload)}</td>
      <td style="padding: 10px 12px; color: #991b1b; font-weight: 500;">${r.error || 'Not updated today'}</td>
    </tr>
  `).join('');

  const successRowsHtml = successReports.map(r => `
    <tr style="border-bottom: 1px solid #e5e7eb;">
      <td style="padding: 8px 12px; color: #374151; font-weight: 500;">${r.brand}</td>
      <td style="padding: 8px 12px; color: #111827;">${r.reportName}</td>
      <td style="padding: 8px 12px; font-family: monospace; color: #6b7280; font-size: 12px;">${r.table}</td>
      <td style="padding: 8px 12px; color: #059669; font-size: 12px;">${formatIstDateTime(r.lastUpload)}</td>
      <td style="padding: 8px 12px; color: #374151; text-align: right;">${r.rowsToday.toLocaleString()}</td>
      <td style="padding: 8px 12px; color: #6b7280; text-align: right;">${r.totalRows.toLocaleString()}</td>
    </tr>
  `).join('');

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; margin: 0; padding: 20px; color: #1f2937; }
      .container { max-width: 900px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
      .header { background: #1e293b; color: #ffffff; padding: 24px; }
      .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 700; background-color: ${statusColor}; color: #ffffff; margin-top: 8px; }
      .stats { display: flex; padding: 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
      .stat-box { flex: 1; text-align: center; padding: 10px; }
      .stat-val { font-size: 24px; font-weight: bold; }
      .stat-lbl { font-size: 12px; color: #64748b; text-transform: uppercase; margin-top: 4px; }
      .content { padding: 24px; }
      h2 { font-size: 16px; margin-top: 24px; margin-bottom: 12px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
      th { background: #f1f5f9; padding: 10px 12px; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
      .footer { background: #f8fafc; padding: 16px 24px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1 style="margin: 0; font-size: 22px;">Daily Automation Sync Summary</h1>
        <div style="font-size: 14px; color: #94a3b8; margin-top: 4px;">Date: ${dateStr} | Generated: ${formatIstDateTime(generatedAt)}</div>
        <div class="badge">${statusBadge}</div>
      </div>

      <div class="stats">
        <div class="stat-box">
          <div class="stat-val" style="color: #3b82f6;">${totalCount}</div>
          <div class="stat-lbl">Total Reports</div>
        </div>
        <div class="stat-box">
          <div class="stat-val" style="color: #10b981;">${successCount}</div>
          <div class="stat-lbl">Successfully Synced</div>
        </div>
        <div class="stat-box">
          <div class="stat-val" style="color: ${failedCount > 0 ? '#ef4444' : '#64748b'};">${failedCount}</div>
          <div class="stat-lbl">Failed / Pending</div>
        </div>
      </div>

      <div class="content">
        ${failedCount > 0 ? `
          <h2 style="color: #dc2626;">🚨 Failed / Un-Synced Reports (${failedCount})</h2>
          <table>
            <thead>
              <tr>
                <th>Brand</th>
                <th>Report Name</th>
                <th>Database Table</th>
                <th>Schedule</th>
                <th>Last Upload (IST)</th>
                <th>Failure Reason</th>
              </tr>
            </thead>
            <tbody>
              ${failedRowsHtml}
            </tbody>
          </table>
        ` : `
          <div style="padding: 16px; background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; color: #065f46; font-weight: 500; text-align: center;">
            ✨ All ${totalCount} monitored reports across Kia, Hyundai, AM Platinum & RSA synced successfully today!
          </div>
        `}

        <h2>✅ All Monitored Reports Overview (${successCount} Synced)</h2>
        <table>
          <thead>
            <tr>
              <th>Brand</th>
              <th>Report Name</th>
              <th>Table</th>
              <th>Last Upload (IST)</th>
              <th style="text-align: right;">Rows Synced Today</th>
              <th style="text-align: right;">Total DB Rows</th>
            </tr>
          </thead>
          <tbody>
            ${successRowsHtml}
          </tbody>
        </table>
      </div>

      <div class="footer">
        Automated Daily Sync Monitoring Service • Scheduled every day at 9:00 PM IST
      </div>
    </div>
  </body>
  </html>
  `;
}

export async function sendDailySummaryEmail({ recipient = config.alertEmailTo, dryRun = false } = {}) {
  logger.info('Collecting daily report statuses...');
  const reportStatuses = await collectDailyReportStatus();
  const failedReports = reportStatuses.filter(r => !r.success);
  const now = new Date();
  const dateStr = formatIstDateOnly(now);

  const subject = failedReports.length > 0
    ? `⚠️ [Daily Alert] ${failedReports.length} Report(s) Failed / Unsynced — ${dateStr}`
    : `✅ [Daily Summary] All Reports Synced Successfully — ${dateStr}`;

  const html = buildEmailHtml(reportStatuses, now);

  if (dryRun) {
    logger.info('Daily summary email dry run completed', {
      subject,
      recipient,
      total: reportStatuses.length,
      failed: failedReports.length,
      success: reportStatuses.length - failedReports.length
    });
    return { success: true, dryRun: true, failedCount: failedReports.length };
  }

  if (!config.alertEmailFrom || !config.alertEmailAppPassword) {
    throw new Error('Email credentials ALERT_EMAIL_FROM / ALERT_EMAIL_APP_PASSWORD not configured');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.alertEmailFrom,
      pass: config.alertEmailAppPassword
    }
  });

  const mailResult = await transporter.sendMail({
    from: `"Automated Reports Monitor" <${config.alertEmailFrom}>`,
    to: recipient,
    subject,
    html
  });

  logger.info('Daily summary email sent successfully', {
    messageId: mailResult.messageId,
    recipient,
    subject,
    failedCount: failedReports.length
  });

  return { success: true, messageId: mailResult.messageId, failedCount: failedReports.length };
}

// Scheduled Runner Mode
if (process.argv[1]?.endsWith('daily-reports-summary-email.js')) {
  const isOnce = process.argv.includes('--once');
  const isDryRun = process.argv.includes('--dry-run');

  if (isOnce || isDryRun) {
    sendDailySummaryEmail({ dryRun: isDryRun })
      .then(res => {
        console.log('Daily summary result:', JSON.stringify(res, null, 2));
        process.exit(0);
      })
      .catch(err => {
        console.error('Failed to execute daily summary email:', err);
        process.exit(1);
      });
  } else {
    // Schedule daily at 21:00 (9:00 PM IST)
    logger.info('Starting Daily Summary Email Cron Scheduler at 21:00 (9:00 PM IST)...');
    cron.schedule('0 21 * * *', async () => {
      logger.info('Executing scheduled 9:00 PM daily summary email...');
      try {
        await sendDailySummaryEmail();
      } catch (err) {
        logger.error('Error in scheduled daily summary email:', err);
      }
    }, {
      timezone: 'Asia/Kolkata'
    });
  }
}
