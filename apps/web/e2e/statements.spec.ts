import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/** The Statements screen (ADR-0051): a statement with no account picked finds its account, is confirmed and imported. */

const CHASE = readFileSync(
  fileURLToPath(new URL('../../../packages/importers/test/corpus/chase-checking.csv', import.meta.url)),
);

test('finds the account of a dropped CSV, confirms it and imports it through the preview', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByLabel('Email').fill(`statements-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Workspace name').fill('Statements household');
  await page.getByRole('radio', { name: /Freelancer/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();

  // Two accounts; the statement's file name carries the checking account's last four digits.
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  for (const [name, last4] of [
    ['Chase checking', '1234'],
    ['Savings', '9876'],
  ]) {
    await page.goto(`/w/${workspaceId}/accounts/new`);
    await page.getByLabel('Account type').selectOption('checking');
    await page.getByLabel('Name').fill(name!);
    await page.getByLabel('Current balance').fill('2,500.00');
    await page.getByLabel('As of').fill('2026-10-01');
    await page.getByText('More details (optional)').click();
    await page.getByLabel('Last 4 digits').fill(last4!);
    await page.getByRole('button', { name: 'Add account' }).click();
    await expect(page.getByRole('heading', { name: name! })).toBeVisible();
  }

  // Statements, next to Receipts and Payslips: no account is picked first.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Statements' }).click();
  await expect(page.getByRole('heading', { name: 'Statements', level: 1 })).toBeVisible();
  await page.getByLabel('Choose statement files or photos').setInputFiles({
    name: 'Chase1234_Activity.csv',
    mimeType: 'text/csv',
    buffer: CHASE,
  });

  // Read and matched: the account found is offered to confirm.
  const item = page.getByTestId('intake-item');
  await expect(item).toContainText('Looks like Chase checking', { timeout: 30_000 });
  await expect(item.getByLabel('Account')).toHaveValue(/.+/);
  await expect(item.getByLabel('Account').locator('option').first()).toHaveText(
    'Chase checking (ending 1234)',
  );
  await item.getByRole('button', { name: 'Import' }).click();

  // The existing preview, then commit.
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]+$/);
  await expect(page.getByTestId('preview-row')).toHaveCount(6, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Import transactions' }).click();
  await expect(page.getByTestId('import-summary')).toContainText('Import complete', { timeout: 30_000 });

  // The import is in the history on the Statements screen.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Statements' }).click();
  const row = page.getByTestId('import-history-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Chase checking');
  await expect(row).toContainText('Imported');
});
