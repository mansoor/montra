import { expect, test } from '@playwright/test';
import { importCsv, nav, onboardHousehold, setAi } from './phase3-helpers';

/**
 * Phase 3: AI settings show a privacy disclosure per mode (UP-06); with AI off, rules and history still
 * categorize and the rest goes to review (graceful degradation, Phase 3 exit criterion).
 */
test('turns AI off and still categorizes imports with rules', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `ai-off-${Date.now()}@example.com`, 'Everyday checking');

  await nav(page, 'Settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'AI', exact: true })
    .click();
  for (const mode of ['builtin', 'byok', 'local', 'off'])
    await expect(page.getByTestId(`ai-disclosure-${mode}`)).toBeVisible();
  await expect(page.getByTestId('disclaimer-financial')).toContainText('not financial advice');
  // The local option asks for an endpoint; switching to it shows the field.
  await page.getByRole('radio', { name: /^Local model/ }).check();
  await expect(page.getByLabel('Local model URL')).toBeVisible();
  await setAi(page, { mode: /^Off/ });
  await expect(page.getByRole('radio', { name: /^Off/ })).toBeChecked();

  // A rule for Netflix.
  await nav(page, 'Rules');
  await page.getByRole('button', { name: 'New rule' }).click();
  const form = page.getByRole('form', { name: 'Rule' });
  await form.getByLabel('Name', { exact: true }).fill('Netflix');
  await form.getByLabel('Value for condition 1').fill('netflix');
  await form.getByLabel('Category', { exact: true }).selectOption({ label: 'Subscriptions' });
  await form.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByTestId('rule-row')).toHaveCount(1);

  await importCsv(
    page,
    'Everyday checking',
    'ai-off.csv',
    ['Date,Description,Amount', '2026-10-02,NETFLIX.COM,-15.49', '2026-10-03,ZQX TRADING POST,-19.99'].join(
      '\n',
    ),
    2,
  );

  // Netflix was categorized by the rule; the unknown merchant waits for review with no suggestion.
  await nav(page, 'Review');
  const rows = page.getByTestId('review-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('ZQX TRADING POST');
  await expect(rows.first().getByTestId('suggested-category')).toContainText('No suggestion');

  await nav(page, 'Transactions');
  const netflix = page.getByTestId('txn-row').filter({ hasText: 'NETFLIX' });
  await expect(netflix).toContainText('Subscriptions');
  await expect(netflix.getByTestId('row-categories')).toHaveAttribute('title', /Netflix/);

  // No AI calls were made.
  await nav(page, 'Settings');
  await page.getByRole('link', { name: 'AI activity' }).click();
  await expect(page.getByText('No AI activity yet.')).toBeVisible();
});
