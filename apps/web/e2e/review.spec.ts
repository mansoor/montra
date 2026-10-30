import { expect, test } from '@playwright/test';
import { importCsv, onboardHousehold, setAi } from './phase3-helpers';

/**
 * Phase 3: an import lands in the review queue (AI-03), keyboard accept and correction (AI-04, PLT-10), and a
 * rule offered after two identical corrections (AI-05).
 */
const CSV = [
  'Date,Description,Amount',
  '2026-10-02,STARBUCKS STORE 1234,-4.50',
  '2026-10-03,STARBUCKS STORE 1234,-5.25',
  '2026-10-04,STARBUCKS STORE 1234,-6.10',
  '2026-10-05,SHELL OIL 5566,-42.00',
  '2026-10-06,KROGER #771,-88.13',
  '2026-10-07,ZQX TRADING POST,-19.99',
].join('\n');

test('reviews an import with the keyboard and turns repeated corrections into a rule', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `review-${Date.now()}@example.com`, 'Everyday checking');
  // A 99% threshold sends every AI suggestion to the queue, so the test doesn't depend on fake confidences.
  await setAi(page, { threshold: 99 });
  await importCsv(page, 'Everyday checking', 'october.csv', CSV, 6);

  // g r opens the review queue from anywhere.
  await page.locator('body').press('g');
  await page.locator('body').press('r');
  await expect(page).toHaveURL(/\/review$/);
  const rows = page.getByTestId('review-row');
  await expect(rows).toHaveCount(6);
  await expect(page.getByTestId('review-total')).toContainText('6 transactions to review');
  await expect(page.getByTestId('review-badge')).toHaveText('6');
  await expect(rows.filter({ hasText: 'STARBUCKS' }).first().getByTestId('confidence')).toBeVisible();

  // ? shows the shortcuts.
  await page.locator('body').press('?');
  await expect(page.getByTestId('shortcut-help')).toContainText('Accept all above a confidence');
  await page.locator('body').press('?');

  // Move to the Shell row and accept it with the keyboard.
  const shellIndex = (await rows.allTextContents()).findIndex((t) => t.includes('SHELL'));
  for (let i = 0; i < shellIndex; i++) await page.locator('body').press('j');
  await expect(rows.nth(shellIndex)).toHaveAttribute('aria-current', 'true');
  await page.locator('body').press('a');
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: 'SHELL' })).toHaveCount(0);

  // Correct two Starbucks rows to Entertainment with `c` + type-ahead; the second offers a rule.
  for (let n = 0; n < 2; n++) {
    const index = (await rows.allTextContents()).findIndex((t) => t.includes('STARBUCKS'));
    await rows.nth(index).click();
    await page.locator('body').press('c');
    const picker = page.getByRole('dialog', { name: 'Choose a category' });
    await expect(picker).toBeVisible();
    await picker.getByRole('combobox').fill('Entertain');
    await picker.getByRole('combobox').press('Enter');
    await expect(picker).toBeHidden();
    await expect(rows).toHaveCount(4 - n);
  }
  const offer = page.getByTestId('rule-offer');
  await expect(offer).toContainText('create a rule?');
  await expect(offer).toContainText('Entertainment');
  await offer.getByRole('button', { name: 'Create and apply to existing' }).click();
  await expect(offer).toBeHidden();

  // The rule is listed.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Rules' }).click();
  await expect(page.getByTestId('rule-row')).toHaveCount(1);
  await expect(page.getByTestId('rule-row')).toContainText('Entertainment');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /Review/ })
    .click();
  await expect(page.getByTestId('review-row').first()).toBeVisible();

  // Accept all at or above 50%: the dialog counts what qualifies.
  await page.locator('body').press('Shift+A');
  const dialog = page.getByRole('dialog', { name: 'Accept all above a confidence' });
  await dialog.getByLabel(/Accept suggestions at or above/).fill('50');
  await expect(dialog.getByTestId('accept-above-count')).toContainText('at or above 50%');
  await dialog.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByTestId('review-announce')).toContainText(/Accepted \d+ transaction/);
});
