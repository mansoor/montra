import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/** Phase 2 flows: statement import with preview, commit, duplicate upload and undo; reconciliation. */

const CHASE = fileURLToPath(
  new URL('../../../packages/importers/test/corpus/chase-checking.csv', import.meta.url),
);

async function onboard(page: Page, email: string, account: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Workspace name').fill('Import household');
  await page.getByRole('radio', { name: /Freelancer/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Add account' }).click();
  await page.getByLabel('Name').fill(account);
  await page.getByLabel('Current balance').fill('2,500.00');
  await page.getByLabel('As of').fill('2026-10-01');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: account })).toBeVisible();
}

test('imports a bank statement, skips a row, commits, warns on re-upload and undoes', async ({ page }) => {
  test.setTimeout(120_000);
  await onboard(page, `import-${Date.now()}@example.com`, 'Chase checking');

  // Upload from the account page (IMP-01).
  await page.getByRole('link', { name: 'Import statement' }).click();
  await expect(page.getByRole('heading', { name: 'Import statement' })).toBeVisible();
  await page.getByLabel('Choose statement files').setInputFiles(CHASE);
  await expect(page.getByTestId('upload-item')).toContainText('chase-checking.csv');
  await page.getByRole('button', { name: 'Upload and preview' }).click();

  // Preview (IMP-06): the worker parses the file; six rows, all new.
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]+$/);
  const rows = page.getByTestId('preview-row');
  await expect(rows).toHaveCount(6, { timeout: 30_000 });
  await expect(page.getByTestId('balance-banner')).toContainText('checks out');
  await expect(rows.filter({ hasText: 'CHECK 1043' })).toContainText('Will be added');

  // Skip the check, then commit (IMP-08).
  await page.getByRole('button', { name: 'Skip row 7' }).click();
  await expect(rows.filter({ hasText: 'CHECK 1043' })).toContainText('Will be skipped');
  await page.getByRole('button', { name: 'Import transactions' }).click();

  // Summary (IMP-08).
  const summary = page.getByTestId('import-summary');
  await expect(summary).toContainText('Import complete', { timeout: 30_000 });
  await expect(page.getByTestId('summary-read')).toContainText('6');
  await expect(page.getByTestId('summary-added')).toContainText('5');
  await expect(page.getByTestId('summary-skipped')).toContainText('1');
  const batchUrl = page.url();

  // The imported rows are in the register.
  await page.getByRole('link', { name: 'View transactions' }).click();
  await expect(page.getByRole('row', { name: /ACME CORP PAYROLL/ })).toBeVisible();

  // Uploading the same file again asks first (IMP-07).
  await page.getByRole('link', { name: 'Import statement' }).click();
  await page.getByLabel('Choose statement files').setInputFiles(CHASE);
  await page.getByRole('button', { name: 'Upload and preview' }).click();
  await expect(page.getByTestId('upload-item')).toContainText(
    /This file was uploaded on .+ — import anyway\?/,
  );

  // Undo the import from history (IMP-09).
  await page.getByRole('link', { name: 'Import history' }).click();
  await expect(page.getByTestId('import-history-row')).toHaveCount(1);
  await page.goto(batchUrl);
  await page.getByRole('button', { name: 'Undo import' }).click();
  await page.getByRole('button', { name: 'Yes, undo' }).click();
  await expect(summary).toContainText('Import undone', { timeout: 30_000 });
  await expect(page.getByTestId('undo-result')).toContainText('5 added transactions removed');
  await page.getByRole('link', { name: 'View transactions' }).click();
  await expect(page.getByRole('row', { name: /ACME CORP PAYROLL/ })).toHaveCount(0);
});

test('reconciles an account against a statement and locks the lines', async ({ page }) => {
  await onboard(page, `reconcile-${Date.now()}@example.com`, 'Savings');

  await page.getByRole('link', { name: 'Reconcile' }).click();
  await page.getByLabel('Statement date').fill('2026-10-31');
  await page.getByLabel('Statement ending balance (USD)').fill('2,500.00');
  await page.getByRole('button', { name: 'Start reconciling' }).click();

  const difference = page.getByTestId('reconcile-difference');
  await expect(difference).toHaveText('$2,500.00');
  const finish = page.getByRole('button', { name: 'Finish reconciliation' });
  await expect(finish).toBeDisabled();
  await page.getByTestId('reconcile-line').getByRole('checkbox').check();
  await expect(difference).toHaveText('$0.00');
  await finish.click();
  await expect(page.getByText('Reconciled. These lines are now locked.')).toBeVisible();
  await expect(page.getByTestId('reconcile-line').getByRole('img', { name: 'Reconciled' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to account' }).first().click();
  await expect(page.getByTestId('reconciled-lock')).toHaveCount(1);
});

test('maps the columns of an unfamiliar file before previewing it', async ({ page }) => {
  await onboard(page, `mapping-${Date.now()}@example.com`, 'Wallet');
  await page.getByRole('link', { name: 'Import statement' }).click();
  await page.getByLabel('Choose statement files').setInputFiles({
    name: 'mystery.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('2026-10-01,COFFEE,4.50,12\n2026-10-02,LUNCH,12.00,13\n2026-10-03,REFUND,3.00,14\n'),
  });
  await page.getByRole('button', { name: 'Upload and preview' }).click();

  // IMP-03: inference is unsure, so the mapping editor opens with the file's first rows.
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('No amounts are negative')).toBeVisible();
  await page.getByLabel('Header row').selectOption('');
  await page.getByLabel('Transactions start at').selectOption({ label: 'Row 1' });
  await page.locator('#role-0').selectOption('date');
  await page.locator('#role-1').selectOption('description');
  await page.locator('#role-2').selectOption('amount');
  await page.locator('#role-3').selectOption('ignore');
  await page.getByLabel('Date format').selectOption('YYYY-MM-DD');
  const preview = page.getByTestId('mapping-preview');
  await expect(preview.getByRole('row')).toHaveCount(4);
  await expect(preview.getByRole('row').nth(1)).toContainText('$4.50');
  await page.getByLabel('Positive amounts are money out').check();
  await expect(preview.getByRole('row').nth(1)).toContainText('-$4.50');
  await page.getByRole('button', { name: 'Apply mapping' }).click();

  const rows = page.getByTestId('preview-row');
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.filter({ hasText: 'COFFEE' })).toContainText('-$4.50');
});
