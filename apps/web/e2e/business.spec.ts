import { expect, test } from '@playwright/test';
import { nav, onboardHousehold } from './phase3-helpers';

/**
 * Phase 8: a sole proprietor invoices a customer, the deposit arrives and pays it, a bill goes in and out, a trip is
 * logged, and it all reaches Schedule C and the accountant's export (BIZ-04..13). Cash basis: nothing counts until paid.
 */
test('invoices, bills and mileage reach Schedule C and the export', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `business-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const today = new Date().toISOString().slice(0, 10);
  const entity = await page.request.post(`${ws}/entities`, {
    data: { type: 'business', name: 'Rivera Studio', businessType: 'sole_prop' },
  });
  expect(entity.status()).toBe(201);
  const entityId = (await entity.json()).id as string;
  const account = await page.request.post(`${ws}/accounts`, {
    data: {
      name: 'Studio checking',
      kind: 'checking',
      entityId,
      openingBalance: { amount: '100000', currency: 'USD' },
      openingDate: `${today.slice(0, 4)}-01-01`,
    },
  });
  expect(account.status()).toBe(201);
  const accountId = (await account.json()).id as string;
  await page.reload();

  // The sidebar offers the business now there is one.
  await nav(page, 'Business');
  await expect(page.getByRole('heading', { name: 'Rivera Studio' })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Business sections' });

  // An invoice for a new customer, with tax on a line (BIZ-05).
  await sections.getByRole('link', { name: 'Invoices' }).click();
  await page.getByRole('link', { name: 'New invoice' }).click();
  await page.getByLabel('Customer name').fill('Bluebird Cafe');
  await page.getByLabel('Customer email').fill('ap@bluebird.example');
  await page.getByLabel('Description', { exact: true }).fill('Menu design');
  await page.getByLabel('Quantity for Menu design').fill('1.5');
  await page.getByLabel('Price for Menu design').fill('100');
  await page.getByLabel('Tax percent for Menu design').fill('8.25');
  await expect(page.getByTestId('invoice-total')).toHaveText('$162.38');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'INV-0001' })).toBeVisible();
  await expect(page.getByTestId('invoice-status')).toHaveText('Draft');

  // Nothing counts until it's paid.
  await page.getByRole('button', { name: 'Email the invoice' }).click();
  await expect(page.getByText('Sent to ap@bluebird.example')).toBeVisible();
  await expect(page.getByTestId('invoice-status')).toHaveText('Sent');
  await expect(
    (await page.request.get(`${ws}/reports/pnl?entityId=${entityId}`)).json(),
  ).resolves.toMatchObject({
    revenue: '0',
  });

  // The deposit is offered, and linking it splits off the tax and counts it once.
  const deposit = await page.request.post(`${ws}/transactions`, {
    data: {
      date: today,
      accountId,
      amount: { amount: '16238', currency: 'USD' },
      payee: 'BLUEBIRD CAFE ACH',
    },
  });
  expect(deposit.status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: 'Use this one' }).click();
  await expect(page.getByText('Linked to the deposit, so it counts once')).toBeVisible();
  await expect(page.getByTestId('invoice-status')).toHaveText('Paid');
  const after = await (await page.request.get(`${ws}/accounts`)).json();
  expect(after.data.find((a: { id: string }) => a.id === accountId).balance.amount).toBe('116238');

  // A bill: in the forecast until it's paid (BIZ-06).
  await sections.getByRole('link', { name: 'Bills' }).click();
  const billForm = page.getByRole('form', { name: 'Add a bill' });
  await billForm.getByLabel('Vendor name').fill('Print Shop');
  await billForm.getByLabel('Amount').fill('40');
  await billForm.getByLabel('Category').selectOption({ label: 'Supplies' });
  await billForm.getByRole('button', { name: 'Add a bill' }).click();
  const bill = page.getByTestId('bill-row').filter({ hasText: 'Print Shop' });
  await expect(bill.getByText('To pay')).toBeVisible();
  await bill.getByRole('button', { name: 'Pay' }).click();
  await bill.getByLabel('Paid from').selectOption({ label: 'Studio checking' });
  await bill.getByRole('button', { name: 'Record payment' }).click();
  await expect(bill.getByText('Paid', { exact: true })).toBeVisible();

  // Customers and vendors follow from all that (BIZ-04).
  await sections.getByRole('link', { name: 'Customers and vendors' }).click();
  await expect(page.getByTestId('party-row').filter({ hasText: 'Bluebird Cafe' })).toBeVisible();

  // A trip takes the rate for its date, and isn't a transaction (BIZ-07).
  await sections.getByRole('link', { name: 'Mileage' }).click();
  const tripForm = page.getByRole('form', { name: 'Log a trip' });
  await tripForm.getByLabel('Miles').fill('100');
  await tripForm.getByLabel('Business purpose').fill('Client visit');
  await tripForm.getByRole('button', { name: 'Log a trip' }).click();
  await expect(page.getByText(/Trip logged at [\d.]+ cents a mile/)).toBeVisible();
  await expect(page.getByTestId('trip-row').filter({ hasText: 'Client visit' })).toBeVisible();

  // Estimated tax at the user's own rate, and Schedule C (BIZ-09, BIZ-10).
  await sections.getByRole('link', { name: 'Taxes' }).click();
  await expect(page.getByTestId('tax-period')).toHaveCount(4);
  await page.getByLabel('Your effective tax rate (%)').fill('25');
  await page.getByRole('button', { name: 'Save rate' }).click();
  await expect(page.getByText('Rate saved')).toBeVisible();
  const schedule = page.getByTestId('schedule-c');
  await expect(schedule.getByRole('row', { name: /Gross receipts or sales.*\$150\.00/ })).toBeVisible();
  await expect(schedule.getByRole('row', { name: /Supplies.*\$40\.00/ })).toBeVisible();
  await expect(schedule.getByRole('row', { name: /Car and truck expenses/ })).toBeVisible();

  // The overview, and each number opens what's behind it.
  await sections.getByRole('link', { name: 'Overview' }).click();
  const pnl = page.getByTestId('pnl');
  await expect(pnl.getByRole('row', { name: /Net profit.*\$110\.00/ })).toBeVisible();
  await page.getByRole('link', { name: 'Income by customer' }).click();
  await expect(
    page.getByTestId('report-customers').getByRole('row', { name: /Bluebird Cafe.*\$150\.00/ }),
  ).toBeVisible();

  // The journal for an accountant (BIZ-13).
  await sections.getByRole('link', { name: 'Settings' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^journal-.*\.csv$/);

  // The bill's payment is in the books, on the calendar's other side from the invoice: nothing is left open.
  await page.goto(`/w/${workspaceId}/business/${entityId}/bills`);
  await expect(
    page.getByTestId('bill-row').filter({ hasText: 'Print Shop' }).getByText('Paid', { exact: true }),
  ).toBeVisible();
});
