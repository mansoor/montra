import { expect, test } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

/**
 * UP-05: every number leads to the transactions behind it, or says how it is worked out. The budget's total spent,
 * Month in review's money in and out and its categories, a goal's savings, and the forecast and net worth lines.
 */
test('numbers lead to their transactions, or say how they are worked out', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `traceable-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const base = `/w/${workspaceId}`;
  const today = new Date().toISOString().slice(0, 10);
  const accounts = (await (await page.request.get(`${ws}/accounts`)).json()).data;
  const categories = (await (await page.request.get(`${ws}/categories`)).json()).data;
  const groceries = categories.find((c: { name: string }) => c.name === 'Groceries');
  const spend = await page.request.post(`${ws}/transactions`, {
    data: {
      date: today,
      accountId: accounts[0].id,
      amount: { amount: '-4210', currency: 'USD' },
      payee: 'Corner Market',
      categoryId: groceries.id,
    },
  });
  expect(spend.status()).toBe(201);
  const behind = async () => {
    await expect(page.getByText('Showing the transactions behind a number')).toBeVisible();
    await expect(page.getByText('Corner Market')).toBeVisible();
  };

  // The budget's total spent, and how 50/30/20 is worked out.
  const budget = await page.request.post(`${ws}/budgets`, {
    data: { entityId: groceries.entityId, name: 'Home' },
  });
  expect(budget.status()).toBe(201);
  await page.goto(`${base}/budget`);
  await expect(page.getByText(/as a share of this period's income/)).toBeVisible();
  await expect(page.getByTestId('budget-spent-drill')).toHaveText('$42.10');
  await page.getByTestId('budget-spent-drill').click();
  await behind();

  // Month in review: money out and each category.
  await page.goto(`${base}/month?month=${today}`);
  await page.getByRole('link', { name: /^Money out/ }).click();
  await behind();
  await page.goBack();
  await page
    .getByRole('region', { name: 'Where the money went' })
    .getByRole('link', { name: 'Groceries', exact: true })
    .click();
  await behind();

  // A goal's savings are its linked account's transactions.
  const savings = await page.request.post(`${ws}/accounts`, {
    data: {
      name: 'Rainy day',
      kind: 'savings',
      openingBalance: { amount: '50000', currency: 'USD' },
      openingDate: today,
    },
  });
  expect(savings.status()).toBe(201);
  const savingsId = (await savings.json()).id as string;
  const goal = await page.request.post(`${ws}/goals`, {
    data: {
      entityId: groceries.entityId,
      type: 'emergency_fund',
      name: 'Cushion',
      target: '100000',
      linkedAccountIds: [savingsId],
    },
  });
  expect(goal.status()).toBe(201);
  await page.goto(`${base}/goals`);
  await expect(page.getByTestId('goal-saved')).toHaveAttribute(
    'href',
    new RegExp(`/transactions\\?entityId=[0-9a-f-]+&accountIds=${savingsId}$`),
  );

  // The forecast and net worth say how they are worked out.
  await page.goto(`${base}/cash-flow?tab=forecast`);
  await expect(page.getByTestId('forecast-hint')).toContainText("starts from today's balance");
  await page.goto(`${base}/cash-flow?tab=net-worth`);
  await expect(page.getByTestId('net-worth-hint')).toContainText('assets less liabilities');
});
