import { expect, test } from '@playwright/test';
import { nav, onboardHousehold } from './phase3-helpers';

// Phase 6: a budget from scratch, a number that drills down to its transactions, and a suggestion applied.
test('budgets, drills a category to its transactions and applies a suggestion', async ({ page }) => {
  await onboardHousehold(page, `planner-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]!;

  await nav(page, 'Budget');
  await expect(page.getByRole('heading', { name: 'Set up a budget' })).toBeVisible();
  await page.getByRole('button', { name: 'Create budget' }).click();
  await expect(page.getByRole('heading', { name: 'Household budget' })).toBeVisible();

  // Assign more than the (zero) income: left to assign goes negative.
  await page.getByLabel('Show all categories').check();
  const groceries = page.getByLabel('Assigned to Groceries');
  await groceries.fill('400');
  await groceries.press('Enter');
  await expect(page.getByTestId('left-to-assign')).toHaveText('-$400.00');
  await expect(page.getByText('Your plan is more than your income.')).toBeVisible();

  // A grocery purchase today shows as the category's activity.
  const accounts = await page.evaluate(
    async (ws) => (await (await fetch(`/api/v1/workspaces/${ws}/accounts`)).json()).data,
    workspaceId,
  );
  const categories = await page.evaluate(
    async (ws) => (await (await fetch(`/api/v1/workspaces/${ws}/categories`)).json()).data,
    workspaceId,
  );
  const today = new Date().toISOString().slice(0, 10);
  const res = await page.evaluate(
    async ({ ws, body }) =>
      (
        await fetch(`/api/v1/workspaces/${ws}/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    {
      ws: workspaceId,
      body: {
        date: today,
        accountId: accounts[0].id,
        amount: { amount: '-4210', currency: 'USD' },
        payee: 'Corner Market',
        categoryId: categories.find((c: { name: string }) => c.name === 'Groceries').id,
      },
    },
  );
  expect(res).toBe(201);
  await page.reload();
  const row = page.getByRole('row', { name: /Groceries/ });
  await expect(row.getByRole('link', { name: '$42.10' })).toBeVisible();
  await expect(row.getByText('$357.90')).toBeVisible();

  // The activity drills down to the transaction behind it.
  await row.getByRole('link', { name: '$42.10' }).click();
  await expect(page.getByText('Showing the transactions behind a number')).toBeVisible();
  await expect(page.getByText('Corner Market')).toBeVisible();

  // The over-assigned plan gets a suggestion that cuts Groceries back, never below what's already spent.
  await nav(page, 'Suggestions');
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByRole('heading', { name: 'Your plan is $400.00 more than your income' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Applied to your budget.')).toBeVisible();
  await nav(page, 'Budget');
  await expect(page.getByTestId('left-to-assign')).toHaveText('-$42.10');

  // Home shows the period's spending, linking to the same transactions.
  await nav(page, 'Home');
  await expect(page.getByRole('link', { name: /Spent\s*\$42\.10/ })).toBeVisible();
});
