import { expect, test } from '@playwright/test';
import { nav, onboardHousehold } from './phase3-helpers';

/** Phase 3: a rule with a live preview, then "apply to existing" as a background job (UP-02). */
test('creates a rule with a live preview and applies it to existing transactions', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `rules-${Date.now()}@example.com`, 'Everyday checking');

  // Two uncategorized fuel purchases and one coffee.
  await nav(page, 'Transactions');
  for (const [payee, amount] of [
    ['Shell Oil', '40.00'],
    ['SHELL #22', '35.50'],
    ['Blue Bottle', '6.00'],
  ] as const) {
    await page.locator('#qa-amount').fill(amount);
    await page.locator('#qa-payee').fill(payee);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText(`Saved ${payee}`)).toBeVisible();
  }

  await nav(page, 'Rules');
  await expect(page.getByRole('heading', { name: 'Rules', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New rule' }).click();
  const form = page.getByRole('form', { name: 'Rule' });
  await form.getByLabel('Name', { exact: true }).fill('Shell → Fuel');
  await form.getByLabel('Field for condition 1').selectOption('payee');
  await form.getByLabel('Operator for condition 1').selectOption('contains');
  await form.getByLabel('Value for condition 1').fill('shell');
  await form.getByLabel('Category', { exact: true }).selectOption({ label: 'Fuel & transport' });

  // Live preview (debounced): both Shell rows match and would change.
  await expect(page.getByTestId('rule-preview-counts')).toContainText('Matches 2 existing transactions', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('rule-preview')).toContainText('Shell Oil');
  await expect(page.getByTestId('rule-preview')).not.toContainText('Blue Bottle');

  await form.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByText('Rule “Shell → Fuel” saved.')).toBeVisible();
  const row = page.getByTestId('rule-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Payee contains “shell”');

  // Apply to existing runs as a job and reports what changed.
  await row.getByRole('button', { name: 'Apply to existing' }).click();
  await expect(row.getByTestId('rule-apply-status')).toContainText('Applied: 2 changed', { timeout: 30_000 });

  await nav(page, 'Transactions');
  await expect(page.getByTestId('txn-row').filter({ hasText: 'Shell Oil' })).toContainText(
    'Fuel & transport',
  );
  await expect(page.getByTestId('txn-row').filter({ hasText: 'Blue Bottle' })).not.toContainText(
    'Fuel & transport',
  );
});
