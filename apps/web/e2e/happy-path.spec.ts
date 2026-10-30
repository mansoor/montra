import { expect, test } from '@playwright/test';

/** Phase 1 happy path: sign in → onboarding → account → quick-add expense → register balance. */
test('a new freelancer records an expense and sees the running balance', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Onboarding (UP-03)
  await expect(page.getByRole('heading', { name: 'Welcome to Montra' })).toBeVisible();
  await page.getByLabel('Workspace name').fill('E2E household');
  await page.getByRole('radio', { name: /Freelancer/ }).check();
  await page.getByLabel('Business name').fill('E2E Studio LLC');
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();

  // Add checking with an opening balance (ACC-05)
  await page.getByRole('link', { name: 'Add account' }).first().click();
  await page.getByLabel('Name').fill('Everyday checking');
  await page.getByLabel('Current balance').fill('2,500.00');
  await page.getByLabel('As of').fill('2026-10-01');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Everyday checking' })).toBeVisible();
  await expect(page.getByTestId('running-balance').first()).toHaveText('$2,500.00');

  // Quick-add an expense (TXN-01): amount → payee → category, Enter submits
  await page.getByRole('link', { name: 'Transactions' }).click();
  await page.getByLabel('Amount').first().fill('42.10');
  await page.getByLabel('Payee').fill('Blue Bottle Coffee');
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Dining out' });
  await page.getByLabel('Date').first().fill('2026-10-05');
  await page.getByLabel('Payee').press('Enter');
  await expect(page.getByText('Saved Blue Bottle Coffee')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Transactions' }).getByText('Blue Bottle Coffee'),
  ).toBeVisible();

  // Register shows the running balance after the expense (DE-06)
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: /Everyday checking/ }).click();
  const balances = page.getByTestId('running-balance');
  await expect(balances).toHaveText(['$2,457.90', '$2,500.00']);
  await expect(page.getByRole('row', { name: /Blue Bottle Coffee/ })).toContainText('$42.10');

  // Simple +/− view
  await page.getByRole('link', { name: '+ / −' }).click();
  await expect(page.getByRole('row', { name: /Blue Bottle Coffee/ })).toContainText('-$42.10');

  // Split one purchase between Personal and Business books (TXN-03, DE-05)
  await page.getByRole('link', { name: 'Transactions' }).click();
  await page.getByLabel('Amount').first().fill('120.00');
  await page.getByLabel('Payee').fill('Costco');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Split transaction' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Category for line 1').selectOption({ label: 'Groceries' });
  await dialog.getByLabel('Amount for line 1').fill('80');
  await dialog.getByLabel('Category for line 2').selectOption({ label: 'Office expense' });
  await expect(dialog.getByRole('button', { name: 'Save split' })).toBeDisabled();
  await expect(dialog.getByTestId('split-remaining')).toHaveText('$40.00 left to allocate');
  await dialog.getByLabel('Amount for line 2').fill('40');
  await expect(dialog.getByTestId('split-remaining')).toHaveText('Fully allocated.');
  await dialog.getByRole('button', { name: 'Save split' }).click();
  await expect(page.getByRole('button', { name: /split into 2 lines/ })).toBeVisible();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Saved Costco')).toBeVisible();
  const costco = page
    .getByRole('list', { name: 'Transactions' })
    .getByRole('listitem')
    .filter({ hasText: 'Costco' });
  await expect(costco).toContainText('Groceries, Office expense');
  await expect(costco).toContainText('-$120.00');
});
