import { logger } from '../utils/logger.js';

async function clickLocator(locator, label, timeout = 15000) {
  logger.info(`Opening ${label}`);
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click();
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

  if (!await repairBillingLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
    await clickLocator(serviceMisMenuButton, 'Service MIS sidebar menu');
  }

  await repairBillingLink.waitFor({ state: 'visible', timeout: 30000 });

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(repairBillingLink, 'Repair Billing menu');
  }

  await clickLocator(reportLink, 'R/O Billing Report page', 30000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
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
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
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

  if (!await repairOrderLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
    await clickLocator(serviceMisMenuButton, 'Service MIS sidebar menu');
  }

  await repairOrderLink.waitFor({ state: 'visible', timeout: 30000 });

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(repairOrderLink, 'Repair Order menu');
  }

  await clickLocator(reportLink, 'Repair Order List page', 30000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
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

  if (!await customerFollowupLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
    await clickLocator(serviceMisMenuButton, 'Service MIS sidebar menu');
  }

  await customerFollowupLink.waitFor({ state: 'visible', timeout: 30000 });

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(customerFollowupLink, 'Customer Followup / Report menu');
  }

  await clickLocator(reportLink, 'Post Service Follow Up Report page', 30000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
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

  if (!await extWarrantyLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
    await clickLocator(serviceMisMenuButton, 'Service MIS sidebar menu');
  }

  await extWarrantyLink.waitFor({ state: 'visible', timeout: 30000 });

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(extWarrantyLink, 'Ext. Warranty menu');
  }

  await clickLocator(reportLink, 'Extended Warranty Report page', 30000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
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
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  logger.info('My Convenience List menu item clicked');
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

  if (!await workProfitLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    const serviceMisMenuButton = page.locator('li.nav_ser_mis > a').first();
    await clickLocator(serviceMisMenuButton, 'Service MIS sidebar menu');
  }

  await workProfitLink.waitFor({ state: 'visible', timeout: 30000 });

  if (!await reportLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clickLocator(workProfitLink, 'Work Profit menu');
  }

  await clickLocator(reportLink, 'Operation Wise Analysis Report page', 30000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  logger.info('Operation Wise Analysis Report menu item clicked');
}
