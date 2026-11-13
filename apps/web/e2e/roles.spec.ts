import { expect, test } from '@playwright/test';
import { nav, onboardHousehold } from './phase3-helpers';

/**
 * Roles and family logins (AUTH-14..17): the owner invites a child from the Family list as a member. Accepting links
 * the child's login to that person, and a member sees no setup pages and only their own settings.
 */
test('invites a family member as a member, who gets only the everyday pages', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const kid = `kid-${stamp}@example.com`;
  await onboardHousehold(page, `roles-${stamp}@example.com`, 'Family checking');

  // Add Kai to the Family list, then invite them from their row.
  await nav(page, 'Settings');
  const main = page.getByRole('navigation', { name: 'Main' });
  await main.getByRole('link', { name: 'Workspace', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Family' })
    .click();
  const add = page.getByRole('form', { name: 'Add family member' });
  await add.getByLabel('Name', { exact: true }).fill('Kai');
  await add.getByLabel('Relationship').selectOption('child');
  await add.getByRole('button', { name: 'Add member' }).click();
  await page.getByRole('button', { name: 'Invite Kai to sign in' }).click();
  const invite = page.getByRole('form', { name: 'Invite someone' });
  await invite.getByLabel('Email', { exact: true }).fill(kid);
  await invite.getByLabel('Role', { exact: true }).selectOption('member');
  await expect(invite.getByText('Adds transactions, receipts and trips')).toBeVisible();
  await invite.getByRole('button', { name: 'Create invite' }).click();
  const linkField = invite.getByLabel(`Invite link for ${kid}`);
  await expect(linkField).toHaveValue(/\/invite\/[A-Za-z0-9_-]{20,}$/);
  const link = await linkField.inputValue();
  await page.reload();
  await expect(page.getByText(`Invited as Member · ${kid} · waiting to accept`)).toBeVisible();

  // Kai accepts in their own browser.
  const kidContext = await browser.newContext();
  const p2 = await kidContext.newPage();
  await p2.goto(link);
  await p2.getByLabel('Email').fill(kid);
  await p2.getByRole('button', { name: 'Continue' }).click();
  await p2.getByRole('button', { name: 'Accept invite' }).click();
  await expect(p2.getByRole('heading', { name: 'Net position' })).toBeVisible();

  // A member records money; setting the books up isn't theirs.
  const kidNav = p2.getByRole('navigation', { name: 'Main' });
  await expect(kidNav.getByRole('link', { name: /^Transactions/ })).toBeVisible();
  await expect(kidNav.getByRole('link', { name: /^Rules/ })).toHaveCount(0);
  await expect(kidNav.getByRole('link', { name: /^Import/ })).toHaveCount(0);
  await kidNav.getByRole('link', { name: /^Settings/ }).click();
  const menu = p2.getByTestId('settings-menu');
  await expect(menu.getByRole('link', { name: 'You', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Workspace', exact: true })).toHaveCount(0);
  await kidContext.close();

  // Kai is one person: in the Family list with their login, and under Sharing as Kai.
  await page.reload();
  await expect(page.getByText(`Signs in as Member · ${kid}`)).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Sharing' })
    .click();
  await expect(page.getByTestId('sharing-member').filter({ hasText: kid })).toContainText(
    'In the family as Kai',
  );
});
