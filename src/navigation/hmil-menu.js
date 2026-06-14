import { logger } from '../utils/logger.js';

async function dismissBlockingMessages(page) {
  const closeCandidates = page.locator([
    '.k-window:visible .k-i-close',
    '.k-window:visible .k-window-action',
    '.k-animation-container:visible .k-i-close',
    '.k-animation-container:visible .k-window-action',
    '.notification_title:visible ~ * .k-i-close',
    '[aria-label="Close"]:visible',
    'button:visible:has-text("OK")',
    'button:visible:has-text("Close")'
  ].join(','));

  const count = await closeCandidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    await closeCandidates.nth(index).click({ force: true, timeout: 1000 }).catch(() => {});
  }

  await page.keyboard.press('Escape').catch(() => {});
}

async function clickLocator(page, locator, label, timeout = 30000) {
  let target = locator.first();

  try {
    await dismissBlockingMessages(page);
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible({ timeout: 250 }).catch(() => false)) {
        target = candidate;
        break;
      }
    }

    const visible = await target.isVisible({ timeout: Math.min(timeout, 2000) }).catch(() => false);

    if (!visible) {
      logger.warn('Hyundai menu item is not visible; dispatching DOM click fallback', { label });
      await target.evaluate(element => element.click());
      return;
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: Math.min(timeout, 5000) });
  } catch (error) {
    logger.warn('Standard Hyundai menu click failed; dispatching DOM click fallback', {
      label,
      error: error.message
    });
    await dismissBlockingMessages(page);
    await target.evaluate(element => element.click());
  }
}

async function openRootMenu(page, selectors, label) {
  const root = page.locator(selectors.join(','));
  await root.first().waitFor({ state: 'attached', timeout: 15000 });
  await clickLocator(page, root, label);
}

async function openParentIfNeeded(page, parentLocator, reportLocator, parentLabel) {
  if (await reportLocator.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  if (await parentLocator.count().catch(() => 0)) {
    await clickLocator(page, parentLocator, parentLabel);
  }
}

async function openAuthenticatedReportUrl(page, reportLink, fallbackPath, label) {
  const reportPath = await reportLink.first()
    .getAttribute('data-url', { timeout: 500 })
    .catch(() => null);
  const targetUrl = new URL(reportPath || fallbackPath, page.url()).href;

  logger.info('Opening Hyundai report URL directly', { label, targetUrl });
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
}

export async function openHmilRepairOrderListReport(page) {
  logger.info('Navigating to Hyundai Service > Repair Order > Repair Order List');
  await dismissBlockingMessages(page);

  const reportLinkSelectors = [
    'li.nav_ser a.menuItem[data-viewid="VIEW-D-00608"]',
    'li.nav_ser a.menuItem[data-url*="selectRepairOrderListMain.dms"]',
    'li.nav_ser a.menuItem[data-title="Repair Order List"]',
    'li.nav_ser a.menuItem:text-is("Repair Order List")',
    'a.menuItem[data-url*="selectRepairOrderListMain.dms"]',
    'a.menuItem[data-title="Repair Order List"]',
    'a.menuItem:text-is("Repair Order List")'
  ].join(',');
  const reportLink = page.locator(reportLinkSelectors).first();

  const reportVisible = await reportLink.isVisible({ timeout: 1500 }).catch(() => false);
  if (!reportVisible) {
    logger.info('Opening Hyundai Service sidebar menu');
    await openRootMenu(page, [
      'li.nav_ser > a[title="Service"]',
      'li.nav_ser > a:has-text("Service")',
      'li.nav_ser > a',
      'a[title="Service"]'
    ], 'Hyundai Service menu');

    const repairOrderParent = page.locator(
      'li.nav_ser li:has(a.menuItem[data-url*="selectRepairOrderListMain.dms"]) > a:not(.menuItem), li.nav_ser a:has-text("Repair Order")'
    ).first();
    logger.info('Expanding Hyundai Repair Order menu group');
    await clickLocator(page, repairOrderParent, 'Hyundai Repair Order menu group');
  }

  await clickLocator(page, reportLink, 'Hyundai Repair Order List page', 30000);
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  logger.info('Hyundai Repair Order List menu item clicked');
}

export async function openHmilCallCenterComplaintServiceList(page) {
  logger.info('Navigating to Hyundai CRM > HMI Call Center Complaint Service List');
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    'li.nav_crm a.menuItem[data-url*="selectHmiCallCenterComplaintList.dms"]',
    'li.nav_crm a.menuItem[data-title="HMI Call Center Complaint Service List"]',
    'li.nav_crm a.menuItem:has-text("HMI Call Center Complaint Service List")',
    'a.menuItem[data-url*="selectHmiCallCenterComplaintList.dms"]',
    'a.menuItem[data-title="HMI Call Center Complaint Service List"]',
    'a.menuItem:has-text("HMI Call Center Complaint Service List")'
  ].join(',')).first();

  if (!await reportLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openRootMenu(page, [
      'li.nav_crm > a[title="CRM"]',
      'li.nav_crm > a:has-text("CRM")',
      'li.nav_crm > a',
      'a[title="CRM"]'
    ], 'Hyundai CRM menu');
  }

  const complaintParent = page
    .locator('li.nav_crm a')
    .filter({ hasText: /^(Complaint|Call Center)$/ })
    .first();
  await openParentIfNeeded(page, complaintParent, reportLink, 'Hyundai call center complaint menu');

  await clickLocator(page, reportLink, 'HMI Call Center Complaint Service List page');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  logger.info('HMI Call Center Complaint Service List menu item clicked');
}

export async function openHmilCustomerComplaintList(page) {
  logger.info('Navigating to Hyundai CRM > Complaint > Customer Complaint List');
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    'li.nav_crm a.menuItem[data-title="Customer Complaint List"]',
    'li.nav_crm a.menuItem:has-text("Customer Complaint List")',
    'a.menuItem[data-title="Customer Complaint List"]',
    'a.menuItem:has-text("Customer Complaint List")'
  ].join(',')).first();

  if (!await reportLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openRootMenu(page, [
      'li.nav_crm > a[title="CRM"]',
      'li.nav_crm > a:has-text("CRM")',
      'li.nav_crm > a',
      'a[title="CRM"]'
    ], 'Hyundai CRM menu');
  }

  const complaintParent = page
    .locator('li.nav_crm a')
    .filter({ hasText: /^Complaint$/ })
    .first();
  await openParentIfNeeded(page, complaintParent, reportLink, 'Hyundai Complaint menu');

  await clickLocator(page, reportLink, 'Customer Complaint List page');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  logger.info('Customer Complaint List menu item clicked');
}

export async function openHmilExtendedWarrantyList(page) {
  logger.info('Navigating to Hyundai MIS > Service Retention Package > Extended Warranty Report');
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-title="Extended Warranty Report"]',
    'li.nav_ser_mis a.menuItem:has-text("Extended Warranty Report")',
    'li.nav_ser_mis a.menuItem[data-url*="selectExtendedWarrantyReport"]',
    'li.nav_ser_mis a.menuItem[data-url*="ExtendedWarrantyReport"]',
    'li.nav_ser_mis a.menuItem[data-url*="extendedWarrantyReport"]',
    'li.nav_ser_mis a.menuItem[data-url*="selectEWReport"]',
    'a.menuItem[data-title="Extended Warranty Report"]',
    'a.menuItem:has-text("Extended Warranty Report")',
    'a.menuItem[data-url*="selectExtendedWarrantyReport"]',
    'a.menuItem[data-url*="ExtendedWarrantyReport"]',
    'a.menuItem[data-url*="extendedWarrantyReport"]',
    'a.menuItem[data-url*="selectEWReport"]'
  ].join(',')).first();

  if (!await reportLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openRootMenu(page, [
      'li.nav_ser_mis > a[title="MIS"]',
      'li.nav_ser_mis > a[title="Service"]',
      'li.nav_ser_mis > a:has-text("MIS")',
      'li.nav_ser_mis > a',
      'a[title="MIS"]'
    ], 'Hyundai MIS Service Retention menu');
  }

  const serviceRetentionParent = page
    .locator('li.nav_ser_mis a')
    .filter({ hasText: /^Service Retention Package$/ })
    .first();
  await openParentIfNeeded(page, serviceRetentionParent, reportLink, 'Hyundai Service Retention Package menu');

  await clickLocator(page, reportLink, 'Extended Warranty Report page');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  logger.info('Extended Warranty Report menu item clicked');
}

export async function openHmilServiceBookingListReport(page) {
  logger.info('Navigating to Hyundai Service > Service Booking > Service Booking List');
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    'li.nav_ser a.menuItem[data-title="Service Booking List"]',
    'li.nav_ser a.menuItem:has-text("Service Booking List")',
    'li.nav_ser a.menuItem[data-url*="ServiceBooking"][data-url*="List"]',
    'li.nav_ser a.menuItem[data-url*="serviceBooking"][data-url*="List"]',
    'li.nav_ser a.menuItem[data-url*="selectServiceBooking"]',
    'li.nav_ser a.menuItem[data-url*="selectServiceAppointment"]',
    'a.menuItem[data-title="Service Booking List"]',
    'a.menuItem:has-text("Service Booking List")',
    'a.menuItem[data-url*="ServiceBooking"][data-url*="List"]',
    'a.menuItem[data-url*="serviceBooking"][data-url*="List"]',
    'a.menuItem[data-url*="selectServiceBooking"]',
    'a.menuItem[data-url*="selectServiceAppointment"]'
  ].join(',')).first();

  if (!await reportLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openRootMenu(page, [
      'li.nav_ser > a[title="Service"]',
      'li.nav_ser > a:has-text("Service")',
      'li.nav_ser > a',
      'a[title="Service"]'
    ], 'Hyundai Service menu');
  }

  const serviceBookingParent = page
    .locator('li.nav_ser a')
    .filter({ hasText: /^Service Booking$/ })
    .first();
  await openParentIfNeeded(page, serviceBookingParent, reportLink, 'Hyundai Service Booking menu');

  await clickLocator(page, reportLink, 'Service Booking List page');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  logger.info('Service Booking List menu item clicked');
}

export async function openHmilTrustPackageSection(page, sectionTitle) {
  logger.info('Navigating to Hyundai Service > TMA Management > trust package section', {
    sectionTitle
  });
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    `li.nav_ser a.menuItem[data-title="${sectionTitle}"]`,
    `li.nav_ser a.menuItem:text-is("${sectionTitle}")`,
    `li.nav_ser a.menuItem:has-text("${sectionTitle}")`,
    `a.menuItem[data-title="${sectionTitle}"]`,
    `a.menuItem:text-is("${sectionTitle}")`,
    `a.menuItem:has-text("${sectionTitle}")`
  ].join(',')).first();

  if (!await reportLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openRootMenu(page, [
      'li.nav_ser > a[title="Service"]',
      'li.nav_ser > a:has-text("Service")',
      'li.nav_ser > a',
      'a[title="Service"]'
    ], 'Hyundai Service menu');
  }

  const tmaParent = page
    .locator('li.nav_ser a')
    .filter({ hasText: /^TMA Management$/ })
    .first();
  await openParentIfNeeded(page, tmaParent, reportLink, 'Hyundai TMA Management menu');

  await clickLocator(page, reportLink, `${sectionTitle} page`);
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  logger.info('Hyundai trust package menu item clicked', { sectionTitle });
}

export async function openHmilPurchaseReport(page) {
  logger.info('Navigating to Hyundai MIS > Monthly Reports > Purchase Report');
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    'li.nav_sal_mis a.menuItem[data-viewid="VIEW-D-00565"]',
    'li.nav_sal_mis a.menuItem[data-url*="selectPurchaseReportMain.dms"]',
    'li.nav_sal_mis a.menuItem[data-title="Purchase Report"]',
    'li.nav_sal_mis a.menuItem:has-text("Purchase Report")',
    'a.menuItem[data-viewid="VIEW-D-00565"]',
    'a.menuItem[data-url*="selectPurchaseReportMain.dms"]',
    'a.menuItem[data-title="Purchase Report"]',
    'a.menuItem:has-text("Purchase Report")'
  ].join(',')).first();

  if (!await reportLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openRootMenu(page, [
      'li.nav_sal_mis.active > a[title="MIS"]',
      'li.nav_sal_mis > a[title="MIS"]',
      'li.nav_sal_mis > a:has-text("MIS")',
      'li.nav_sal_mis > a',
      'a[title="MIS"]'
    ], 'Hyundai Sales MIS menu');
  }

  const monthlyReportsParent = page
    .locator('li.nav_sal_mis a')
    .filter({ hasText: /^Monthly Reports$/ })
    .first();
  await openParentIfNeeded(page, monthlyReportsParent, reportLink, 'Hyundai Monthly Reports menu');

  await clickLocator(page, reportLink, 'Purchase Report page');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  logger.info('Purchase Report menu item clicked');
}

export async function openHmilOperationWiseAnalysisReport(page) {
  logger.info('Navigating to Hyundai MIS > Work Profit > Operation Wise Analysis Report');
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-viewid="VIEW-D-00617"]',
    'li.nav_ser_mis a.menuItem[data-url*="selectOperationWiseAnalysisReportMain.dms"]',
    'li.nav_ser_mis a.menuItem[data-title="Operation Wise Analysis Report"]',
    'li.nav_ser_mis a.menuItem:has-text("Operation Wise Analysis Report")',
    'a.menuItem[data-viewid="VIEW-D-00617"]',
    'a.menuItem[data-url*="selectOperationWiseAnalysisReportMain.dms"]',
    'a.menuItem[data-title="Operation Wise Analysis Report"]',
    'a.menuItem:has-text("Operation Wise Analysis Report")'
  ].join(',')).first();

  if (!await reportLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openRootMenu(page, [
      'li.nav_ser_mis > a[title="MIS"]',
      'li.nav_ser_mis > a[title="Service"]',
      'li.nav_ser_mis > a:has-text("MIS")',
      'li.nav_ser_mis > a',
      'a[title="MIS"]'
    ], 'Hyundai MIS Work Profit menu');
  }

  const workProfitParent = page
    .locator('li.nav_ser_mis a')
    .filter({ hasText: /^Work Profit$/ })
    .first();
  await openParentIfNeeded(page, workProfitParent, reportLink, 'Hyundai Work Profit menu');

  await clickLocator(page, reportLink, 'Operation Wise Analysis Report page');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  logger.info('Operation Wise Analysis Report menu item clicked');
}

export async function openHmilWarrantyClaim(page) {
  logger.info('Navigating to Hyundai Service > Claim > Warranty Claim');
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    'li.nav_ser a.menuItem[data-title="Warranty Claim"]',
    'li.nav_ser a.menuItem:text-is("Warranty Claim")',
    'li.nav_ser a.menuItem[data-url*="WarrantyClaim"]',
    'li.nav_ser a.menuItem[data-url*="warrantyClaim"]',
    'a.menuItem[data-title="Warranty Claim"]',
    'a.menuItem:text-is("Warranty Claim")'
  ].join(','));

  await openAuthenticatedReportUrl(
    page,
    reportLink,
    '/ser/sere/selectWarrantyClaimRequestMain.dms',
    'Hyundai Warranty Claim'
  );
  logger.info('Hyundai Warranty Claim report opened');
}

export async function openHmilWarrantyClaimList(page) {
  logger.info('Navigating to Hyundai MIS > Claim > Warranty Claim List');
  await dismissBlockingMessages(page);

  const reportLink = page.locator([
    'li.nav_ser_mis a.menuItem[data-title="Warranty Claim List"]',
    'li.nav_ser_mis a.menuItem:text-is("Warranty Claim List")',
    'li.nav_ser_mis a.menuItem[data-url*="WarrantyClaimList"]',
    'li.nav_ser_mis a.menuItem[data-url*="warrantyClaimList"]',
    'a.menuItem[data-title="Warranty Claim List"]',
    'a.menuItem:text-is("Warranty Claim List")'
  ].join(','));

  await openAuthenticatedReportUrl(
    page,
    reportLink,
    '/mis/misc/selectWarrantyClaimListMain.dms',
    'Hyundai Warranty Claim List'
  );
  logger.info('Hyundai Warranty Claim List report opened');
}
