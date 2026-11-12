import { expect, test } from '@playwright/test';
import { nav, onboardHousehold } from './phase3-helpers';

/**
 * Category management (ACC-08..10, ACC-12) and the Settings menu: Settings → Workspace opens tabbed sections, and
 * Categories adds, renames, archives and brings back a category. Miscellaneous is there from the start.
 */
test('adds, renames, archives and unarchives a category from Settings', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `categories-${Date.now()}@example.com`, 'Everyday checking');

  // The groups of settings are menu items under Settings; each opens its sections as tabs.
  await nav(page, 'Settings');
  const main = page.getByRole('navigation', { name: 'Main' });
  await main.getByRole('link', { name: 'Workspace', exact: true }).click();
  await expect(main.getByRole('link', { name: 'Workspace', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await tabs.getByRole('link', { name: 'Categories' }).click();
  await expect(tabs.getByRole('link', { name: 'Categories' })).toHaveAttribute('aria-current', 'page');

  // Miscellaneous is in Daily living already.
  const daily = page.getByTestId('category-group-Daily living');
  await expect(daily.getByLabel('Name of Miscellaneous')).toBeVisible();

  // Add one: it lands in the group chosen.
  const add = page.getByRole('form', { name: 'Add a category' });
  await add.getByLabel('New category').fill('Bag fees');
  await add.getByLabel('Group').selectOption({ label: 'Daily living' });
  await add.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByText('Added Bag fees.')).toBeVisible();
  await expect(daily.getByLabel('Name of Bag fees')).toHaveValue('Bag fees');

  // The same name again is refused.
  await add.getByLabel('New category').fill('bag fees');
  await add.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByText("There's already a category called “Bag fees”")).toBeVisible();

  // Rename it.
  await daily.getByLabel('Name of Bag fees').fill('Checkout bag fees');
  await daily.getByRole('button', { name: 'Save' }).click();
  await expect(daily.getByLabel('Name of Checkout bag fees')).toHaveValue('Checkout bag fees');

  // Archive it: it leaves the group and waits under Archived, from where it comes back.
  await daily.getByRole('button', { name: 'Archive Checkout bag fees' }).click();
  await expect(daily.getByLabel('Name of Checkout bag fees')).toHaveCount(0);
  await page.getByLabel('Show archived').check();
  const archived = page.getByTestId('archived-categories');
  await archived.getByRole('button', { name: 'Unarchive Checkout bag fees' }).click();
  await expect(daily.getByLabel('Name of Checkout bag fees')).toBeVisible();
  await expect(archived).toHaveCount(0);
});
