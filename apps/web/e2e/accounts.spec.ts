import { expect, test } from '@playwright/test';
import pg from 'pg';
import { nav, onboardHousehold } from './phase3-helpers';

/** Every account in one place: by kind, with totals for each kind and for everything, and adding one from there. */
test('the accounts page groups by kind and totals what you have and owe', async ({ page }) => {
  test.setTimeout(90_000);
  // Joint checking opens with $2,500.00.
  await onboardHousehold(page, `accounts-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const entityId = ((await (await page.request.get(ws)).json()).entities as { id: string }[])[0]!.id;
  const add = async (name: string, kind: string, amount: string) => {
    const res = await page.request.post(`${ws}/accounts`, {
      data: {
        name,
        kind,
        entityId,
        openingBalance: { amount, currency: 'USD' },
        openingDate: '2026-10-01',
      },
    });
    expect(res.status()).toBe(201);
  };
  await add('Second checking', 'checking', '50000');
  await add('College fund', 'savings', '1000000');
  await add('Visa', 'credit_card', '30000');
  await add('Car loan', 'loan', '200000');

  await nav(page, 'Accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();

  const group = (name: string) => page.getByRole('region', { name, exact: true });
  await expect(page.getByTestId('accounts-group').getByRole('heading')).toHaveText([
    'Checking',
    'Savings',
    'Credit card',
    'Loan',
  ]);
  await expect(group('Checking').getByTestId('accounts-group-total')).toContainText('$3,000.00');
  await expect(group('Checking').getByTestId('accounts-row')).toHaveCount(2);
  await expect(group('Savings').getByTestId('accounts-group-total')).toContainText('$10,000.00');
  await expect(group('Credit card').getByTestId('accounts-group-total')).toContainText('$300.00');
  await expect(group('Credit card').getByTestId('accounts-group-total')).toContainText('owed');
  await expect(group('Loan').getByTestId('accounts-group-total')).toContainText('$2,000.00');

  // $13,000.00 held, $2,300.00 owed.
  await expect(page.getByTestId('accounts-assets')).toContainText('$13,000.00');
  await expect(page.getByTestId('accounts-liabilities')).toContainText('$2,300.00');
  await expect(page.getByTestId('accounts-net')).toContainText('$10,700.00');

  // Currencies are totalled apart, never added together.
  // A foreign opening balance needs that day's rate (ACC-04), loaded the way the fx.daily job stores it (ADR-0014).
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra',
  });
  await db.connect();
  try {
    await db.query(`select app.upsert_fx_rates('ecb', $1::jsonb)`, [
      JSON.stringify([{ date: '2026-10-01', base: 'EUR', quote: 'USD', rate: '1.0912' }]),
    ]);
  } finally {
    await db.end();
  }
  const euro = await page.request.post(`${ws}/accounts`, {
    data: {
      name: 'Euro savings',
      kind: 'savings',
      entityId,
      currency: 'EUR',
      openingBalance: { amount: '90000', currency: 'EUR' },
      openingDate: '2026-10-01',
    },
  });
  expect(euro.status()).toBe(201);
  await page.reload();
  await expect(group('Savings').getByTestId('accounts-group-total')).toContainText('$10,000.00');
  await expect(group('Savings').getByTestId('accounts-group-total')).toContainText('€900.00');
  await expect(page.getByTestId('accounts-net')).toContainText('$10,700.00');
  await expect(page.getByTestId('accounts-net')).toContainText('€900.00');

  // A row opens its account.
  await group('Savings')
    .getByRole('link', { name: /College fund/ })
    .click();
  await expect(page.getByRole('heading', { name: 'College fund' })).toBeVisible();

  // Adding one is a button on the page now, not a menu item, and the new account joins its group.
  await nav(page, 'Accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Add account' }),
  ).toHaveCount(0);
  await page.getByRole('main').getByRole('link', { name: 'Add account' }).click();
  await page.getByLabel('Name').fill('Third checking');
  await page.getByLabel('Current balance').fill('100.00');
  await page.getByLabel('As of').fill('2026-10-01');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Third checking' })).toBeVisible();
  await nav(page, 'Accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  await expect(group('Checking').getByTestId('accounts-group-total')).toContainText('$3,100.00');
  await expect(page.getByTestId('accounts-net')).toContainText('$10,800.00');
});

test('a workspace with no accounts says so, and offers to add one', async ({ page }) => {
  await onboardHousehold(page, `accounts-empty-${Date.now()}@example.com`, 'In the first workspace');
  const res = await page.request.post('/api/v1/workspaces', {
    data: { name: 'Empty one', type: 'household', baseCurrency: 'USD', timeZone: 'UTC' },
  });
  expect(res.status()).toBe(201);
  await page.goto(`/w/${(await res.json()).id}/accounts`);
  await expect(page.getByText('No accounts yet.')).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Add account' })).toBeVisible();
  await expect(page.getByTestId('accounts-summary')).toHaveCount(0);
});

/** ADR-0023: the form asks what a type has, and the page shows it, with its balance over time. */
test('each account type asks for and shows what it has', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `account-types-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  await page.goto(`/w/${workspaceId}/accounts/new`);
  const type = page.getByLabel('Account type');

  await expect(page.getByLabel('Bank (optional)')).toBeVisible();
  await expect(page.getByLabel('Current balance')).toBeVisible();

  await type.selectOption('cash');
  await expect(page.getByText('Cash you keep on hand.')).toBeVisible();
  await expect(page.getByLabel('Bank (optional)')).toHaveCount(0);
  await expect(page.getByLabel('Last 4 digits')).toHaveCount(0);

  await type.selectOption('asset');
  await expect(page.getByLabel('Current value')).toBeVisible();
  await expect(page.getByTestId('account-details')).toHaveCount(0);

  await type.selectOption('mortgage');
  await expect(page.getByLabel('Lender (optional)')).toBeVisible();
  await expect(page.getByLabel('Amount owed')).toBeVisible();

  await type.selectOption('credit_card');
  await expect(page.getByLabel('Card issuer (optional)')).toBeVisible();

  // A wrong rate opens the section it's in and says so.
  await page.getByLabel('Name').fill('Visa');
  await page.getByText('More details (optional)').click();
  await page.getByLabel('APR %').fill('nineteen');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByText('Enter a rate from 0 to 100')).toBeVisible();

  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Card issuer (optional)').fill('Chase');
  await page.getByLabel('Last 4 digits').fill('4242');
  await page.getByLabel('Amount owed').fill('300.00');
  await page.getByLabel('As of').fill(monthAgo);
  await page.getByLabel('Credit limit').fill('5000');
  await page.getByLabel('APR %').fill('19.99');
  await page.getByLabel('Minimum payment').fill('35');
  await page.getByRole('button', { name: 'Add account' }).click();

  await expect(page.getByRole('heading', { name: 'Visa' })).toBeVisible();
  await expect(page.getByTestId('account-about')).toHaveText('Credit card · Chase · ···· 4242');
  await expect(page.getByTestId('fact-limit')).toContainText('$5,000.00');
  await expect(page.getByTestId('fact-available')).toContainText('$4,700.00');
  // 19.99 * 100 in floating point truncates to 19.98.
  await expect(page.getByTestId('fact-rate')).toContainText('19.99%');
  await expect(page.getByTestId('fact-min-payment')).toContainText('$35.00');

  // Balance over time, and the period stays when the register view changes.
  const history = page.getByTestId('balance-history');
  await expect(history.getByRole('heading', { name: 'Amount owed over time' })).toBeVisible();
  await expect(history.locator('svg')).toBeVisible();
  await expect(history.getByRole('link', { name: '1Y' })).toHaveAttribute('aria-current', 'true');
  await history.getByRole('link', { name: '3M' }).click();
  await expect(history.getByRole('link', { name: '3M' })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('link', { name: '+ / −' }).click();
  await expect(page).toHaveURL(/view=simple/);
  await expect(history.getByRole('link', { name: '3M' })).toHaveAttribute('aria-current', 'true');

  // Settings saves the rate exactly too.
  await page.getByTestId('account-facts').getByRole('link', { name: 'Edit details' }).click();
  const planning = page.locator('details', { hasText: 'APR %' });
  await planning.locator('summary').click();
  await planning.getByLabel('APR %').fill('18.99');
  await planning.getByRole('button', { name: 'Save' }).click();
  await expect(planning.getByText('Saved')).toBeVisible();
  await page.goBack();
  await page.reload();
  await expect(page.getByTestId('fact-rate')).toContainText('18.99%');

  // A new account has nothing to draw yet, and says so rather than showing an empty chart.
  await page.goto(`/w/${workspaceId}/accounts/new`);
  await type.selectOption('cash');
  await page.getByLabel('Name').fill('Wallet');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Wallet' })).toBeVisible();
  await expect(page.getByTestId('balance-history')).toContainText('more than one day of history');
  await expect(page.getByTestId('account-facts')).toContainText('low-balance warning');
});
