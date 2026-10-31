import { expect, test } from '@playwright/test';
import { nav, onboardHousehold, setAi } from './phase3-helpers';

/** Phase 3: natural-language quick add (TXN-06) and the editor's category suggestion (AI-01/06). */
test('adds a transaction from a sentence and suggests a category in the editor', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `quick-${Date.now()}@example.com`, 'Amex Gold');

  await nav(page, 'Transactions');
  await page.getByRole('button', { name: 'Type a sentence' }).click();
  await page
    .getByRole('textbox', { name: 'Describe the transaction' })
    .fill('lunch 18.50 amex client meeting');

  // Parsed fields appear as editable chips, with the words that mapped to them highlighted.
  const chips = page.getByTestId('qa-chips');
  await expect(chips.getByLabel('Amount')).toHaveValue('18.50', { timeout: 15_000 });
  await expect(chips.getByLabel('Account')).toHaveValue(/.+/);
  await expect(page.getByTestId('qa-highlight')).toContainText('18.50');
  await expect(page.getByTestId('qa-source')).toBeVisible();
  await chips.getByLabel('Payee').fill('Lunch');

  await page.getByRole('textbox', { name: 'Describe the transaction' }).press('Enter');
  await expect(page.getByText('Saved Lunch')).toBeVisible();
  const row = page.getByTestId('txn-row').filter({ hasText: 'Lunch' });
  await expect(row).toContainText('-$18.50');

  // Back to the form; the editor suggests a category for an uncategorized coffee. A 99% threshold keeps
  // the pipeline from auto-applying it, so the entry is saved uncategorized with the suggestion pending.
  await setAi(page, { threshold: 99 });
  await nav(page, 'Transactions');
  await page.locator('#qa-amount').fill('4.75');
  await page.locator('#qa-payee').fill('Starbucks');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Saved Starbucks')).toBeVisible();
  await page.getByTestId('txn-row').filter({ hasText: 'Starbucks' }).getByRole('link').first().click();
  const suggestion = page.getByTestId('category-suggestion');
  await expect(suggestion).toContainText('Suggested:', { timeout: 15_000 });
  await suggestion.getByRole('button', { name: 'Use it' }).click();
  await expect(page.locator('#ed-category')).not.toHaveValue('');
});
