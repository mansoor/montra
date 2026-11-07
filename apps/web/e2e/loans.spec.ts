import { expect, test } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

/** ADR-0024: adding a mortgage with its payments tracked, paying it, and seeing it everywhere upcoming payments show. */
test('a tracked mortgage works out its payments and follows the balance', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `loans-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  await page.goto(`/w/${workspaceId}/accounts/new`);
  await page.getByLabel('Account type').selectOption('mortgage');

  // It asks how to track it, and the balance is the default, as before.
  const choice = page.getByTestId('loan-track-choice');
  await expect(choice.getByRole('radio', { name: /Just the balance/ })).toBeChecked();
  await expect(page.getByTestId('loan-terms')).toHaveCount(0);
  await choice.getByRole('radio', { name: /Track payments too/ }).check();
  await expect(page.getByTestId('loan-terms')).toBeVisible();
  await expect(page.getByLabel('Currency')).toHaveCount(0);

  // Terms it can't use are refused where they are, and nothing is created.
  await page.getByLabel('Name').fill('Home mortgage');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByText('Enter this to track payments.')).toBeVisible();

  await page.getByLabel('Lender (optional)').fill('First Bank');
  await page.getByLabel('Original loan amount').fill('200000');
  await page.getByLabel('Interest rate %').fill('6');
  await expect(page.getByText('Worked out as $1,199.10')).toBeVisible();
  await page.getByLabel('Loan start date').fill(inDays(-27));
  await page.getByLabel('First payment date').fill(inDays(3));
  await page.getByLabel('Paid from').selectOption({ label: 'Joint checking' });
  await page.getByLabel('Escrow for insurance (monthly)').fill('100');
  await page.getByRole('button', { name: 'Add account' }).click();

  await expect(page.getByRole('heading', { name: 'Home mortgage' })).toBeVisible();
  await expect(page.getByText('Owed: $200,000.00')).toBeVisible();
  const next = page.getByTestId('loan-next');
  await expect(next).toContainText('$1,299.10');
  await expect(next).toContainText('from Joint checking');
  await expect(page.getByTestId('loan-next-principal')).toContainText('$199.10');
  await expect(page.getByTestId('loan-next-interest')).toContainText('$1,000.00');
  await expect(page.getByTestId('loan-next-escrow')).toContainText('$100.00');
  await expect(page.getByTestId('loan-rate')).toContainText('6.00%');
  // The next year shows, and the rest are there if wanted.
  await expect(page.getByTestId('loan-schedule-table').getByTestId('loan-row-upcoming')).toHaveCount(12);
  await expect(page.getByText('Show the other 348 payments')).toBeVisible();

  const accountPath = new URL(page.url()).pathname;

  // It shows where upcoming payments are, linked back to the loan.
  for (const path of ['recurring', 'upcoming']) {
    await page.goto(`/w/${workspaceId}/${path}`);
    const row = page.getByTestId('loan-payment-row');
    await expect(row).toContainText('Home mortgage');
    await expect(row).toContainText('$1,299.10');
    await expect(row).toContainText('from Joint checking');
  }
  await page.getByTestId('loan-payment-row').getByRole('link', { name: 'Home mortgage' }).click();
  await expect(page.getByRole('heading', { name: 'Home mortgage' })).toBeVisible();

  // Recording it reduces what's owed, with $1,000.00 extra on principal.
  const form = page.getByRole('form', { name: 'Record payment' });
  await form.getByLabel('Extra to principal').fill('1000');
  await form.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Owed: $198,800.90')).toBeVisible();
  await expect(page.getByTestId('loan-next-interest')).toContainText('$994.00');
  await expect(page.getByTestId('loan-row-paid').first()).toContainText('$1,199.10');

  // A new rate applies from here on.
  const settings = page.getByTestId('loan-settings');
  await settings.locator('summary').click();
  await settings.getByLabel('Interest rate %').fill('7');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('loan-rate')).toContainText('7.00%');
  await expect(page.getByTestId('loan-next-interest')).toContainText('$1,159.67');
  await expect(page.getByTestId('loan-row-paid').first()).toContainText('$1,000.00');

  // Undoing puts it back.
  await page.getByRole('button', { name: 'Undo payment 1' }).click();
  await expect(page.getByText('Payment removed.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Owed: $200,000.00')).toBeVisible();

  // Stopping keeps the account, and offers to track it again.
  await page.goto(accountPath);
  await page.getByTestId('loan-settings').locator('summary').click();
  await page.getByRole('button', { name: 'Stop tracking payments' }).click();
  await expect(page.getByTestId('track-loan')).toBeVisible();
  await expect(page.getByTestId('loan-panel')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Home mortgage' })).toBeVisible();
});

test('a balance-only loan stays as it was, and can start tracking later', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `loans-later-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  await page.goto(`/w/${workspaceId}/accounts/new`);
  await page.getByLabel('Account type').selectOption('loan');
  await page.getByLabel('Name').fill('Car loan');
  await page.getByLabel('Amount owed').fill('15000');
  await page.getByLabel('As of').fill(inDays(-30));
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Car loan' })).toBeVisible();
  await expect(page.getByTestId('loan-panel')).toHaveCount(0);

  const track = page.getByTestId('track-loan');
  await track.locator('summary').click();
  await track.getByLabel('Original loan amount').fill('20000');
  await track.getByLabel('Interest rate %').fill('5');
  await track.getByLabel('First payment date').fill(inDays(5));
  await track.getByRole('button', { name: 'Track payments' }).click();
  await expect(page.getByTestId('loan-panel')).toBeVisible();
  // Interest on what's owed today, not on the original amount.
  await expect(page.getByTestId('loan-next-interest')).toContainText('$62.50');
  await expect(page.getByText('Owed: $15,000.00')).toBeVisible();

  // A line of credit isn't offered this.
  await page.goto(`/w/${workspaceId}/accounts/new`);
  await page.getByLabel('Account type').selectOption('line_of_credit');
  await expect(page.getByTestId('loan-track-choice')).toHaveCount(0);
});
