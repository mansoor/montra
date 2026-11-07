import { expect, test } from '@playwright/test';
import { onboardHousehold } from './phase3-helpers';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

/** ADR-0026: a card's statement, what's due, a payment rule for the forecast, and paying it. */
test('a card shows its statement, what’s due, and pays it', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `cards-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const statementDay = Number(inDays(-3).slice(8));
  const dueDay = Number(inDays(15).slice(8));

  await page.goto(`/w/${workspaceId}/accounts/new`);
  await page.getByLabel('Account type').selectOption('credit_card');
  await page.getByLabel('Name').fill('Visa');
  await page.getByLabel('Amount owed').fill('0');
  await page.getByLabel('As of').fill(inDays(-40));
  await page.getByText('More details (optional)').click();
  await page.getByLabel('Credit limit').fill('5000');
  await page.getByLabel('Minimum payment').fill('35');
  await page.getByLabel('Statement closes on day').selectOption(String(statementDay));
  await page.getByLabel('Payment due on day').selectOption(String(dueDay));
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: 'Visa' })).toBeVisible();
  const cardId = new URL(page.url()).pathname.split('/').pop()!;

  // $500.00 before the statement closed, $70.00 since.
  for (const [date, amount] of [
    [inDays(-5), '-50000'],
    [inDays(-1), '-7000'],
  ] as const) {
    await page.request.post(`${ws}/transactions`, {
      data: { date, accountId: cardId, amount: { amount, currency: 'USD' }, payee: 'Shop' },
    });
  }
  await page.reload();
  const due = page.getByTestId('card-due');
  await expect(due).toContainText('$500.00');
  await expect(due).toContainText('minimum');
  await expect(page.getByTestId('card-statement')).toContainText('$500.00');
  await expect(page.getByTestId('card-since')).toContainText('$70.00');
  await expect(page.getByTestId('fact-available')).toContainText('$4,430.00');
  await expect(page.getByTestId('card-utilization')).toContainText('11.40%');

  // A rule for the forecast.
  const settings = page.getByTestId('card-settings');
  await settings.locator('summary').click();
  await settings.getByLabel('In the forecast, pay').selectOption({ label: 'The statement balance' });
  await settings.getByLabel('Paid from').selectOption({ label: 'Joint checking' });
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('card-planned')).toContainText('Joint checking');
  await expect(page.getByTestId('card-planned')).toContainText('$500.00');

  // It's on Upcoming.
  await page.goto(`/w/${workspaceId}/upcoming`);
  const row = page.getByTestId('card-due-row');
  await expect(row).toContainText('Visa');
  await expect(row).toContainText('$500.00');
  await row.getByRole('link', { name: 'Visa' }).click();

  // Paying the minimum leaves the rest due; paying the rest clears it.
  const pay = page.getByRole('form', { name: 'Pay' });
  await pay.getByRole('radio', { name: 'Minimum' }).check();
  await pay.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('card-due')).toContainText('$465.00');
  await page.getByRole('form', { name: 'Pay' }).getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('card-due')).toContainText('Paid in full');
  await expect(page.getByText('Owed: $70.00')).toBeVisible();

  await page.setViewportSize({ width: 360, height: 760 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});
