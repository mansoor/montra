import { expect, test } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

/**
 * Business assets (BIZ-16, BIZ-17; ADR-0035): a large equipment purchase is offered as an asset, recorded from the
 * transaction, depreciated for last year, handed to an employee and back, and sold. Made-up people only.
 */
test('a purchase becomes an asset, is depreciated, handed over and sold', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `assets-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const lastYear = new Date().getUTCFullYear() - 1;
  const entity = await page.request.post(`${ws}/entities`, {
    data: { type: 'business', name: 'Orchard Design', businessType: 'llc' },
  });
  expect(entity.status()).toBe(201);
  const entityId = (await entity.json()).id as string;
  const account = await page.request.post(`${ws}/accounts`, {
    data: {
      name: 'Orchard checking',
      kind: 'checking',
      entityId,
      openingBalance: { amount: '1000000', currency: 'USD' },
      openingDate: `${lastYear}-01-01`,
    },
  });
  const accountId = (await account.json()).id as string;
  const categories = (await (await page.request.get(`${ws}/categories`)).json()).data as {
    id: string;
    name: string;
    entityId: string;
  }[];
  const office = categories.find((c) => c.name === 'Office expense' && c.entityId === entityId)!;
  const purchase = await page.request.post(`${ws}/transactions`, {
    data: {
      date: `${lastYear}-03-01`,
      accountId,
      amount: { amount: '-320000', currency: 'USD' },
      payee: 'COMPUTER STORE',
      categoryId: office.id,
    },
  });
  expect(purchase.status()).toBe(201);
  const purchaseId = (await purchase.json()).id as string;
  const person = await page.request.post(`${ws}/payroll/people`, {
    data: {
      entityId,
      kind: 'employee',
      firstName: 'Robin',
      lastName: 'Sample',
      hireDate: `${lastYear}-01-02`,
    },
  });
  expect(person.status()).toBe(201);
  const personId = (await person.json()).id as string;

  // Over $2,500 on an equipment-like category: the transaction offers to record it as an asset.
  await page.goto(`/w/${workspaceId}/transactions/${purchaseId}`);
  await expect(page.getByTestId('asset-hint')).toBeVisible();
  await page.getByRole('link', { name: 'Record as an asset?' }).click();
  await expect(page.getByTestId('asset-purchase')).toContainText('COMPUTER STORE');
  const form = page.getByRole('form', { name: 'Record an asset' });
  await form.getByLabel('Name').fill('Design laptop');
  await form.getByLabel('Serial or tag').fill('SN-42');
  await expect(form.getByLabel('Cost')).toHaveValue('3200.00');
  await form.getByRole('button', { name: 'Record an asset' }).click();
  await expect(page).toHaveURL(/\/assets\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'Design laptop' })).toBeVisible();
  await expect(page.getByTestId('asset-book-value')).toHaveText('$3,200.00');
  // MACRS 5-year: 20% in the first year.
  await expect(page.getByTestId('schedule-row').first()).toContainText('$640.00');

  // Last year's depreciation goes into the books, and Schedule C line 13 has it.
  await page.getByRole('link', { name: '← Assets' }).click();
  const post = page.getByRole('form', { name: 'Post depreciation' });
  await post.getByLabel('Post depreciation through').selectOption(String(lastYear));
  await post.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByText('Depreciation entries posted: 1')).toBeVisible();
  const scheduleC = await (
    await page.request.get(`${ws}/reports/schedule-c?entityId=${entityId}&year=${lastYear}`)
  ).json();
  expect(scheduleC.lines.find((l: { line: string }) => l.line === '13').amount).toBe('64000');

  // Handed to Robin: their page lists it, and it comes back.
  await page.getByRole('link', { name: 'Design laptop' }).click();
  const handOver = page.getByRole('form', { name: 'Hand over' });
  await handOver.getByLabel('Person').selectOption({ label: 'Robin Sample' });
  await handOver.getByRole('button', { name: 'Hand over' }).click();
  await expect(page.getByTestId('asset-holder')).toContainText('With Robin Sample since');
  await page.goto(`/w/${workspaceId}/business/${entityId}/people/${personId}`);
  await expect(page.getByTestId('held-assets')).toContainText('Design laptop');
  await page
    .getByTestId('held-assets')
    .getByRole('link', { name: /Design laptop/ })
    .click();
  await page
    .getByRole('form', { name: 'Mark returned' })
    .getByRole('button', { name: 'Mark returned' })
    .click();
  await expect(page.getByText('Marked returned')).toBeVisible();
  await expect(page.getByTestId('assignment-row')).toContainText('Robin Sample');

  // Sold today for $1,500, with the deposit going into the business's checking account.
  const sell = page.getByRole('form', { name: 'Record the disposal' });
  await sell.getByLabel('Proceeds').fill('1500');
  await sell.getByRole('button', { name: 'Record the disposal' }).click();
  await expect(page.getByTestId('asset-disposal')).toContainText('Loss');
  const sold = await (await page.request.get(`${ws}/business-assets?entityId=${entityId}`)).json();
  const laptop = sold.assets[0];
  expect(laptop.disposal.proceeds).toBe('150000');
  // This year is the disposal year: half of 32% = 16% of 3,200 = 512 more, so book value 2,048 and a loss of 548.
  expect(laptop.disposal.gain).toBe('-54800');
});
