import { expect, test } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

/** ADR-0027: a car's equity, counting cash, money owed with a due date, savings interest, and properties on Accounts. */
test('each remaining account type does its own thing', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `other-types-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const post = async (data: object) =>
    (await (await page.request.post(`${ws}/accounts`, { data })).json()).id as string;

  // A car with its loan: equity is what it's worth less what's owed.
  const loan = await post({
    name: 'Car loan',
    kind: 'loan',
    openingBalance: { amount: '1200000', currency: 'USD' },
    openingDate: inDays(-30),
  });
  await page.goto(`/w/${workspaceId}/accounts/new`);
  await page.getByLabel('Account type').selectOption('asset');
  await page.getByLabel('Name').fill('Family car');
  await page.getByLabel('Current value').fill('18000');
  await page.getByText('More details (optional)').click();
  await page.getByLabel('Purchase price').fill('25000');
  await page.getByLabel('Bought on').fill(inDays(-400));
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Family car' })).toBeVisible();
  const asset = page.getByTestId('asset-panel');
  await expect(asset.getByTestId('asset-change')).toContainText('-$7,000.00');
  await asset.getByLabel('Loan against it').selectOption({ label: 'Car loan' });
  await asset.getByRole('button', { name: 'Save' }).click();
  await expect(asset.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('asset-owed')).toContainText('$12,000.00');
  await expect(page.getByTestId('asset-equity')).toContainText('$6,000.00');
  // A car has no statements to import.
  await expect(page.getByRole('link', { name: 'Import statement' })).toHaveCount(0);
  expect(loan).toBeTruthy();

  // Cash is counted.
  const wallet = await post({
    name: 'Wallet',
    kind: 'cash',
    openingBalance: { amount: '12000', currency: 'USD' },
    openingDate: inDays(-10),
  });
  await page.goto(`/w/${workspaceId}/accounts/${wallet}`);
  await expect(page.getByRole('link', { name: 'Reconcile' })).toHaveCount(0);
  const count = page.getByTestId('cash-count');
  await count.getByLabel('Counted').fill('85.50');
  await count.getByRole('button', { name: 'Update' }).click();
  await expect(count.getByText('Cash updated.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Balance: $85.50')).toBeVisible();

  // Money owed to family, due in ten days: on its page and the calendar.
  await page.goto(`/w/${workspaceId}/accounts/new`);
  await page.getByLabel('Account type').selectOption('liability');
  await page.getByLabel('Name').fill('Owed to Sam');
  await page.getByLabel('Owed to (optional)').fill('Sam');
  await page.getByLabel('Amount owed').fill('400');
  await page.getByText('More details (optional)').click();
  await page.getByLabel('Due date').fill(inDays(10));
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Owed to Sam' })).toBeVisible();
  await expect(page.getByTestId('debt-due')).toBeVisible();
  const items = (await (await page.request.get(`${ws}/calendar?from=${inDays(0)}&to=${inDays(20)}`)).json())
    .items as { name: string; kind: string; amount: string }[];
  expect(items).toContainEqual(
    expect.objectContaining({ name: 'Owed to Sam', kind: 'bill', amount: '-40000' }),
  );

  // Savings shows the interest it's earned this year.
  const savings = await post({
    name: 'Rainy day',
    kind: 'savings',
    interestRateBps: 425,
    openingBalance: { amount: '1000000', currency: 'USD' },
    openingDate: inDays(-30),
  });
  const categories = (await (await page.request.get(`${ws}/categories`)).json()).data as {
    id: string;
    name: string;
  }[];
  await page.request.post(`${ws}/transactions`, {
    data: {
      date: inDays(0),
      accountId: savings,
      amount: { amount: '3550', currency: 'USD' },
      payee: 'Bank',
      categoryId: categories.find((c) => c.name === 'Interest income')!.id,
    },
  });
  await page.goto(`/w/${workspaceId}/accounts/${savings}`);
  await expect(page.getByTestId('fact-interest-earned')).toContainText('$35.50');
  await expect(page.getByTestId('fact-rate')).toContainText('4.25%');

  // A rental property counts on Accounts, as it does on Home.
  const rental = (
    await (
      await page.request.post(`${ws}/entities`, { data: { type: 'rental', name: 'Elm Rentals' } })
    ).json()
  ).id as string;
  const property = await page.request.post(`${ws}/properties`, {
    data: {
      entityId: rental,
      name: 'Elm House',
      type: 'sfh',
      purchasePrice: '30000000',
      purchaseDate: inDays(-500),
    },
  });
  expect(property.status()).toBe(201);
  await page.goto(`/w/${workspaceId}/accounts`);
  await expect(page.getByTestId('accounts-property')).toContainText('Elm House');
  await expect(page.getByTestId('accounts-properties-total')).toContainText('$300,000.00');

  await page.setViewportSize({ width: 360, height: 760 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});
