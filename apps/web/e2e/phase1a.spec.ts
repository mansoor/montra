import { expect, test, type Page } from '@playwright/test';

/** Phase 1a flows: edit, bulk review, recurring confirm, partner invite (TXN-05/10, DE-10, AUTH-10). */

async function signIn(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

test('owner edits, bulk-reviews, confirms a recurring bill and invites a partner', async ({
  page,
  browser,
}) => {
  const stamp = Date.now();
  const owner = `owner-${stamp}@example.com`;
  const partner = `partner-${stamp}@example.com`;

  // Set up: workspace, checking account, one categorized and one uncategorized expense.
  await page.goto('/');
  await signIn(page, owner);
  await page.getByLabel('Workspace name').fill('Phase 1a household');
  await page.getByRole('radio', { name: /Freelancer/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();
  await nav(page, 'Add account');
  await page.getByLabel('Name').fill('Joint checking');
  await page.getByLabel('Current balance').fill('5000');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Joint checking' })).toBeVisible();

  await nav(page, 'Transactions');
  await page.getByLabel('Amount').first().fill('18.50');
  await page.getByLabel('Payee').fill('Blue Bottle Coffee');
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Dining out' });
  await page.getByLabel('Payee').press('Enter');
  await expect(page.getByText('Saved Blue Bottle Coffee')).toBeVisible();
  await page.getByLabel('Amount').first().fill('7.25');
  await page.getByLabel('Payee').fill('SQ *MYSTERY 0423');
  await page.getByLabel('Payee').press('Enter');
  await expect(page.getByText('Saved SQ *MYSTERY 0423')).toBeVisible();

  // Edit a transaction's category (DE-10) and see the journal follow.
  await page
    .getByRole('list', { name: 'Transactions' })
    .getByRole('link', { name: 'Blue Bottle Coffee' })
    .click();
  await expect(page.getByRole('form', { name: 'Edit transaction' })).toBeVisible();
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Groceries' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(page.getByTestId('journal-entry')).toContainText('Groceries');
  await expect(page.getByTestId('journal-entry')).not.toContainText('Dining out');

  // Bulk-mark reviewed from the Needs review filter (TXN-10).
  await nav(page, 'Transactions');
  await page.getByRole('link', { name: 'Needs review', exact: true }).click();
  await expect(page.getByTestId('txn-row')).toHaveCount(1);
  await page.getByRole('checkbox', { name: /Select SQ \*MYSTERY 0423/ }).check();
  await page.getByLabel('Action', { exact: true }).selectOption('reviewed');
  await page.getByRole('button', { name: 'Apply to 1' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Updated 1.' })).toBeVisible();
  await expect(page.getByText('No transactions here.')).toBeVisible();

  // Monthly recurring item → scheduled occurrence → confirm with the actual amount (TXN-05).
  await nav(page, 'Recurring');
  await page.getByLabel('Name', { exact: true }).fill('Rent');
  await page.getByLabel('Amount', { exact: true }).fill('1500');
  await page.getByLabel('Payee').fill('Oak Street Apartments');
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Rent' });
  await page.getByLabel('Repeats', { exact: true }).selectOption('monthly');
  await page.getByRole('button', { name: 'Create recurring item' }).click();
  await expect(page.getByText(/Created Rent\. Next on/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recurring items' })).toContainText('Monthly');

  await nav(page, 'Upcoming');
  const row = page.getByTestId('upcoming-row').filter({ hasText: 'Oak Street Apartments' });
  await expect(row).toContainText('expected -$1,500.00');
  await row.getByLabel('Actual amount').fill('1450');
  await row.getByRole('button', { name: /Confirm Oak Street Apartments/ }).click();
  await expect(page.getByText('Confirmed Oak Street Apartments.')).toBeVisible();
  await expect(page.getByTestId('upcoming-row')).toHaveCount(0);
  await nav(page, 'Transactions');
  await expect(page.getByTestId('txn-row').filter({ hasText: 'Oak Street Apartments' })).toContainText(
    '-$1,450.00',
  );

  // Invite a partner and accept in a second browser context (AUTH-10, UP-04).
  await nav(page, 'Settings');
  await page.getByRole('link', { name: 'Sharing' }).click();
  await page.getByLabel('Email', { exact: true }).fill(partner);
  await page.getByLabel('Role', { exact: true }).selectOption('partner');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const linkField = page.getByLabel(`Invite link for ${partner}`);
  await expect(linkField).toHaveValue(/\/invite\/[A-Za-z0-9_-]{20,}$/);
  const link = await linkField.inputValue();

  const partnerContext = await browser.newContext();
  const p2 = await partnerContext.newPage();
  await p2.goto(link);
  await expect(p2).toHaveURL(/\/sign-in\?next=%2Finvite%2F/);
  await signIn(p2, partner);
  await expect(p2.getByRole('heading', { name: 'You’ve been invited' })).toBeVisible();
  await p2.getByRole('button', { name: 'Accept invite' }).click();
  await expect(p2.getByRole('heading', { name: 'Net position' })).toBeVisible();
  await expect(p2.getByLabel('Workspace')).toHaveText('Phase 1a household');
  // A partner sees the Personal books only by default.
  await expect(p2.getByRole('link', { name: /Joint checking/ })).toBeVisible();
  await partnerContext.close();

  await page.reload();
  await expect(page.getByRole('list', { name: 'Members' })).toContainText(partner);
  await expect(page.getByRole('list', { name: 'Members' })).toContainText('partner');
});
