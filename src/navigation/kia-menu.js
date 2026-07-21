import { logger } from '../utils/logger.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickLocator(locator, label, timeout = 15000) {
  logger.info(`Opening ${label}`);
  const page = typeof locator.page === 'function' ? locator.page() : null;
  try {
    await locator.waitFor({ state: 'visible', timeout });
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout });
    await page?.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  } catch (error) {
    logger.warn('Standard menu click failed; dispatching DOM click fallback', {
      label,
      error: error.message
    });
    await locator.evaluate(element => element.click());
    await page?.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  }
}

async function ensureMenuTargetVisible(menuButton, targetLocator, label, timeout = 5000) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await targetLocator.isVisible({ timeout: 500 }).catch(() => false)) {
      return;
    }

    logger.info('Ensuring menu section is open', { label, attempt });
    await clickLocator(menuButton, label, timeout);

    if (await targetLocator.isVisible({ timeout: 1000 }).catch(() => false)) {
      return;
    }
  }

  await targetLocator.waitFor({ state: 'visible', timeout });
}

async function openSalesMisReport(page, { sectionText, reportText, label }) {
  logger.info(`Navigating to MIS > ${sectionText} > ${reportText}`);

  const salesMisMenu = page.locator('li.nav_sal_mis').first();
  await salesMisMenu.waitFor({ state: 'visible', timeout: 15000 });

  const salesMisMenuButton = page.locator('li.nav_sal_mis > a[title="MIS"], li.nav_sal_mis > a').first();
  const sectionLink = page
    .locator('li.nav_sal_mis a')
    .filter({ hasText: new RegExp(`^${escapeRegex(sectionText)}$`) })
    .first();
  const reportLink = page
    .locator('li.nav_sal_mis a.menuItem, li.nav_sal_mis a')
    .filter({ hasText: new RegExp(`^${escapeRegex(reportText)}$`) })
    .first();

  await ensureMenuTargetVisible(salesMisMenuButton, sectionLink, 'Sales MIS sidebar menu');

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(sectionLink, `${sectionText} menu`);
  }

  await clickLocator(reportLink, label, 30000);
  logger.info('Sales MIS menu item clicked', {
    sectionText,
    reportText
  });
}

async function openSalesMenuReport(page, { sectionText, reportText, label }) {
  logger.info(`Navigating to Sales > ${sectionText} > ${reportText}`);

  const salesMenu = page.locator('li.nav_sal').first();
  await salesMenu.waitFor({ state: 'visible', timeout: 15000 });

  const salesMenuButton = page.locator('li.nav_sal > a').first();
  const sectionLink = page
    .locator('li.nav_sal a')
    .filter({ hasText: new RegExp(`^${escapeRegex(sectionText)}$`) })
    .first();
  const reportLink = page
    .locator('li.nav_sal a.menuItem, li.nav_sal a')
    .filter({ hasText: new RegExp(`^${escapeRegex(reportText)}$`) })
    .first();

  await ensureMenuTargetVisible(salesMenuButton, sectionLink, 'Sales sidebar menu');

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(sectionLink, `${sectionText} menu`);
  }

  await clickLocator(reportLink, label, 30000);
  logger.info('Sales menu item clicked', {
    sectionText,
    reportText
  });
}

export async function openBookingReport(page) {
  await openSalesMisReport(page, {
    sectionText: 'Monthly Reports',
    reportText: 'Booking Report',
    label: 'Booking Report page'
  });
}

export async function openSalesReport(page) {
  await openSalesMisReport(page, {
    sectionText: 'Monthly Reports',
    reportText: 'Sales Report',
    label: 'Sales Report page'
  });
}

export async function openEnquiryReport(page) {
  await openSalesMisReport(page, {
    sectionText: 'Monthly Reports',
    reportText: 'Enquiry Report',
    label: 'Enquiry Report page'
  });
}

export async function openAccessoriesCounterSalesReport(page) {
  await openSalesMisReport(page, {
    sectionText: 'MIS Sales',
    reportText: 'Accessories Counter Sales Report',
    label: 'Accessories Counter Sales Report page'
  });
}

export async function openRoBillingReport(page) {
  logger.info('Navigating to MIS > Repair Billing > R/O Billing Report');

  const serviceMisMenu = page.locator('li.nav_ser_mis').first();
  await serviceMisMenu.waitFor({ state: 'visible', timeout: 15000 });

  const repairBillingLink = page
    .locator('li.nav_ser_mis a')
    .filter({ hasText: /^Repair Billing$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-viewid="VIEW-D-00597"]',
    'li.nav_ser_mis a.menuItem[data-url="/mis/misc/selectRoBillingReportMain.dms"]',
    'li.nav_ser_mis a.menuItem[data-title="R/O Billing Report"]',
    'li.nav_ser_mis a.menuItem:has-text("R/O Billing Report")'
  ].join(',')).first();

  const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
  await ensureMenuTargetVisible(serviceMisMenuButton, repairBillingLink, 'Service MIS sidebar menu');

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(repairBillingLink, 'Repair Billing menu');
  }

  await clickLocator(reportLink, 'R/O Billing Report page', 30000);
  logger.info('R/O Billing Report menu item clicked');
}

export async function openKiaCallCenterComplaintList(page) {
  logger.info('Navigating to CRM > Complaint > KIN Call Center Complaint List');

  const crmMenu = page.locator('li.nav_crm').first();
  await crmMenu.waitFor({ state: 'visible', timeout: 15000 });

  const complaintLink = page
    .locator('li.nav_crm a')
    .filter({ hasText: /^Complaint$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_crm a.menuItem[data-viewid="VIEW-D-00721"]',
    'li.nav_crm a.menuItem[data-url="/crm/crmb/selectHmiCallCenterComplaintList.dms"]',
    'li.nav_crm a.menuItem[data-title="KIN Call Center Complaint List"]',
    'li.nav_crm a.menuItem:has-text("KIN Call Center Complaint List")'
  ].join(',')).first();

  if (!await complaintLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const crmMenuButton = page.locator('li.nav_crm > a').first();
    await clickLocator(crmMenuButton, 'CRM sidebar menu');
  }

  await complaintLink.waitFor({ state: 'visible', timeout: 30000 });

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(complaintLink, 'Complaint menu');
  }

  await clickLocator(reportLink, 'KIN Call Center Complaint List page', 30000);
  logger.info('KIN Call Center Complaint List menu item clicked');
}

export async function openOpenRoYearlyReport(page) {
  logger.info('Navigating to Service MIS > Repair Order > Repair Order List');

  const serviceMisMenu = page.locator('li.nav_ser_mis').first();
  await serviceMisMenu.waitFor({ state: 'visible', timeout: 15000 });

  const repairOrderLink = page
    .locator('li.nav_ser_mis a')
    .filter({ hasText: /^Repair Order$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-viewid="VIEW-D-00608"]',
    'li.nav_ser_mis a.menuItem[data-url="/mis/misc/selectRepairOrderListMain.dms"]',
    'li.nav_ser_mis a.menuItem[data-title="Repair Order List"]',
    'li.nav_ser_mis a.menuItem:has-text("Repair Order List")'
  ].join(',')).first();

  const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
  await ensureMenuTargetVisible(serviceMisMenuButton, repairOrderLink, 'Service MIS sidebar menu');

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(repairOrderLink, 'Repair Order menu');
  }

  await clickLocator(reportLink, 'Repair Order List page', 30000);
  logger.info('Repair Order List menu item clicked');
}

export async function openPsfYearlyReport(page) {
  logger.info('Navigating to Service MIS > Customer Followup / Report > Post Service Follow Up Report');

  const serviceMisMenu = page.locator('li.nav_ser_mis').first();
  await serviceMisMenu.waitFor({ state: 'visible', timeout: 15000 });

  const customerFollowupLink = page
    .locator('li.nav_ser_mis a')
    .filter({ hasText: /^Customer Followup \/ Report$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-viewid="VIEW-D-00591"]',
    'li.nav_ser_mis a.menuItem[data-url="/mis/misc/selectPostServiceFollowUpReportMain.dms"]',
    'li.nav_ser_mis a.menuItem[data-title="Post Service Follow Up Report"]',
    'li.nav_ser_mis a.menuItem:has-text("Post Service Follow Up Report")'
  ].join(',')).first();

  const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
  await ensureMenuTargetVisible(serviceMisMenuButton, customerFollowupLink, 'Service MIS sidebar menu');

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(customerFollowupLink, 'Customer Followup / Report menu');
  }

  await clickLocator(reportLink, 'Post Service Follow Up Report page', 30000);
  logger.info('Post Service Follow Up Report menu item clicked');
}

export async function openEwReport(page) {
  logger.info('Navigating to Service MIS > Ext. Warranty > Extended Warranty Report');

  const serviceMisMenu = page.locator('li.nav_ser_mis').first();
  await serviceMisMenu.waitFor({ state: 'visible', timeout: 15000 });

  const extWarrantyLink = page
    .locator('li.nav_ser_mis a')
    .filter({ hasText: /^Ext\. Warranty$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-viewid="VIEW-D-00592"]',
    'li.nav_ser_mis a.menuItem[data-url="/mis/misc/selectExtendedWarrantyReportMain.dms"]',
    'li.nav_ser_mis a.menuItem[data-title="Extended Warranty Report"]',
    'li.nav_ser_mis a.menuItem:has-text("Extended Warranty Report")'
  ].join(',')).first();

  const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
  await ensureMenuTargetVisible(serviceMisMenuButton, extWarrantyLink, 'Service MIS sidebar menu');

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(extWarrantyLink, 'Ext. Warranty menu');
  }

  await clickLocator(reportLink, 'Extended Warranty Report page', 30000);
  logger.info('Extended Warranty Report menu item clicked');
}

export async function openMcpReport(page) {
  logger.info('Navigating to Service > My Convenience > My Convenience List');

  const serviceMenu = page.locator('li.nav_ser').first();
  await serviceMenu.waitFor({ state: 'visible', timeout: 15000 });

  const myConvenienceLink = page
    .locator('li.nav_ser a')
    .filter({ hasText: /^My Convenience$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_ser a.menuItem[data-viewid="VIEW-D-01182"]',
    'li.nav_ser a.menuItem[data-url="/ser/serf/selectMyConvenienceListMain.dms"]',
    'li.nav_ser a.menuItem[data-title="My Convenience List"]',
    'li.nav_ser a.menuItem:has-text("My Convenience List")'
  ].join(',')).first();

  if (!await myConvenienceLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const serviceMenuButton = page.locator('li.nav_ser > a').first();
    await clickLocator(serviceMenuButton, 'Service sidebar menu');
  }

  await myConvenienceLink.waitFor({ state: 'visible', timeout: 30000 });

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(myConvenienceLink, 'My Convenience menu');
  }

  await clickLocator(reportLink, 'My Convenience List page', 30000);
  logger.info('My Convenience List menu item clicked');
}

export async function openServiceAppointmentListReport(page) {
  logger.info('Navigating to Service > Service Appointment > Service Appointment List');

  const serviceMenuButton = page.locator([
    'li.nav_ser > a[title="Service"]',
    'li.nav_ser > a',
    '#gnb > li.nav_ser > a',
    'a[title="Service"]'
  ].join(',')).first();
  await serviceMenuButton.waitFor({ state: 'attached', timeout: 15000 });

  const serviceAppointmentLink = page
    .locator('li.nav_ser a')
    .filter({ hasText: /^Service Appointment$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_ser a.menuItem[data-viewid="VIEW-D-00193"]',
    'li.nav_ser a.menuItem[data-viewid="VIEW-D-00497"]',
    'li.nav_ser a.menuItem[data-url*="selectSvcBookingListMain.dms"]',
    'li.nav_ser a.menuItem[data-url*="selectServiceAppointmentList"]',
    'li.nav_ser a.menuItem[data-title="Service Appointment List"]',
    'li.nav_ser a.menuItem:has-text("Service Appointment List")',
    'a.menuItem[data-viewid="VIEW-D-00193"]',
    'a.menuItem[data-viewid="VIEW-D-00497"]',
    'a.menuItem[data-url*="selectSvcBookingListMain.dms"]',
    'a.menuItem[data-url*="selectServiceAppointmentList"]',
    'a.menuItem[data-title="Service Appointment List"]',
    'a.menuItem:has-text("Service Appointment List")'
  ].join(',')).first();

  if (!await reportLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await clickLocator(serviceMenuButton, 'Service sidebar icon/menu');
    await page.waitForTimeout(500);
  }

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    if (await serviceAppointmentLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await clickLocator(serviceAppointmentLink, 'Service Appointment menu');
    } else {
      logger.warn('Service Appointment section label was not visible; attempting direct report link click');
    }
  }

  await clickLocator(reportLink, 'Service Appointment List page', 30000);
  logger.info('Service Appointment List menu item clicked');
}

export async function openServiceAppointmentListReportFromServiceMis(page) {
  logger.info('Navigating to Service MIS > Service Appointment > Service Appointment List');

  const serviceMisMenu = page.locator('li.nav_ser_mis').first();
  await serviceMisMenu.waitFor({ state: 'visible', timeout: 15000 });

  const serviceAppointmentLink = page
    .locator('li.nav_ser_mis a')
    .filter({ hasText: /^Service Appointment$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-viewid="VIEW-D-00497"]',
    'li.nav_ser_mis a.menuItem[data-url="/mis/misb/selectSvcBookingListMain.dms"]',
    'li.nav_ser_mis a.menuItem[data-title="Service Appointment List"]',
    'li.nav_ser_mis a.menuItem:has-text("Service Appointment List")'
  ].join(',')).first();

  const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
  await ensureMenuTargetVisible(serviceMisMenuButton, serviceAppointmentLink, 'Service MIS sidebar menu');

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(serviceAppointmentLink, 'Service Appointment menu');
  }

  await clickLocator(reportLink, 'Service Appointment List page', 30000);
  logger.info('Service Appointment List menu item clicked from Service MIS');
}

export async function openAdvWiseLubricantsVasReport(page) {
  logger.info('Navigating to Service MIS > Work Profit > Operation Wise Analysis Report');

  const serviceMisMenu = page.locator('li.nav_ser_mis').first();
  await serviceMisMenu.waitFor({ state: 'visible', timeout: 15000 });

  const workProfitLink = page
    .locator('li.nav_ser_mis a')
    .filter({ hasText: /^Work Profit$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-viewid="VIEW-D-00617"]',
    'li.nav_ser_mis a.menuItem[data-url="/mis/misc/selectOperationWiseAnalysisReportMain.dms"]',
    'li.nav_ser_mis a.menuItem[data-title="Operation Wise Analysis Report"]',
    'li.nav_ser_mis a.menuItem:has-text("Operation Wise Analysis Report")'
  ].join(',')).first();

  const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
  await ensureMenuTargetVisible(serviceMisMenuButton, workProfitLink, 'Service MIS sidebar menu');

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(workProfitLink, 'Work Profit menu');
  }

  await clickLocator(reportLink, 'Operation Wise Analysis Report page', 30000);
  logger.info('Operation Wise Analysis Report menu item clicked');
}

export async function openDemoCarListReport(page) {
  logger.info('Navigating to Sales MIS > Monthly Reports > Purchase Report');

  const salesMisMenu = page.locator('li.nav_sal_mis').first();
  await salesMisMenu.waitFor({ state: 'visible', timeout: 15000 });

  const monthlyReportsLink = page
    .locator('li.nav_sal_mis a')
    .filter({ hasText: /^Monthly Reports$/ })
    .first();

  const reportLink = page.locator([
    'li.nav_sal_mis a.menuItem[data-viewid="VIEW-D-00565"]',
    'li.nav_sal_mis a.menuItem[data-url="/mis/misa/selectPurchaseReportMain.dms"]',
    'li.nav_sal_mis a.menuItem[data-title="Purchase Report"]',
    'li.nav_sal_mis a.menuItem:has-text("Purchase Report")'
  ].join(',')).first();

  if (!await monthlyReportsLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const salesMisMenuButton = page.locator('li.nav_sal_mis > a').first();
    await clickLocator(salesMisMenuButton, 'Sales MIS sidebar menu');
  }

  await monthlyReportsLink.waitFor({ state: 'visible', timeout: 30000 });

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(monthlyReportsLink, 'Monthly Reports menu');
  }

  await clickLocator(reportLink, 'Purchase Report page', 30000);
  logger.info('Purchase Report menu item clicked');
}

export async function openPurchaseReport(page) {
  await openSalesMisReport(page, {
    sectionText: 'Monthly Reports',
    reportText: 'Purchase Report',
    label: 'Purchase Report page'
  });
}

export async function openReceiptReport(page) {
  await openSalesMisReport(page, {
    sectionText: 'Monthly Reports',
    reportText: 'Receipt Report',
    label: 'Receipt Report page'
  });
}

export async function openDealerChangePage(page) {
  logger.info('Navigating to Master > Personal Info > Dealer Change');

  const masterMenu = page.locator('li.nav_cmm').first();
  await masterMenu.waitFor({ state: 'visible', timeout: 15000 });

  const personalInfoLink = page
    .locator('li.nav_cmm a')
    .filter({ hasText: /^Personal Info$/ })
    .first();

  const dealerChangeLink = page.locator([
    'li.nav_cmm a.menuItem[data-viewid="VIEW-D-00046"]',
    'li.nav_cmm a.menuItem[data-url="/cmm/cmmh/selectDealerChangeMain.dms"]',
    'li.nav_cmm a.menuItem[data-title="Dealer Change"]',
    'li.nav_cmm a.menuItem:has-text("Dealer Change")'
  ].join(',')).first();

  if (!await personalInfoLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const masterMenuButton = page.locator('li.nav_cmm > a').first();
    await clickLocator(masterMenuButton, 'Master sidebar menu');
  }

  if (!await personalInfoLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    logger.warn('Personal Info menu is still hidden after opening Master; using DOM click fallback');
    await personalInfoLink.evaluate(element => element.click());
  }

  if (!await dealerChangeLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(personalInfoLink, 'Personal Info menu');
  }

  await clickLocator(dealerChangeLink, 'Dealer Change page', 5000);
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  logger.info('Dealer Change menu item clicked');
}

export async function openDealerVehicleStockMgtReport(page) {
  await openSalesMenuReport(page, {
    sectionText: 'Order/Stock',
    reportText: 'Dealer Vehicle Stock Mgt',
    label: 'Dealer Vehicle Stock Mgt page'
  });
}
