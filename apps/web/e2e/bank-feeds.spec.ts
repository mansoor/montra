import { expect, test } from '@playwright/test';

/**
 * ADR-0055 (FEED-01..07): an owner connects a bank feed from Settings → Bank feeds with a SimpleFIN setup token, creates
 * a Montra account for one of its accounts, and the worker's sync brings that account's posted transactions in by
 * itself (nothing to decide, and the balance matches). The SimpleFIN is the synthetic one (playwright.config.ts,
 * apps/api/test/fakes/simplefin-server.ts), reached only with SIMPLEFIN_ALLOW_LOCAL_HTTP=on: no real service is used.
 */
const SIMPLEFIN = `http://127.0.0.1:${Number(process.env.E2E_SIMPLEFIN_PORT ?? 4655)}`;

test('an owner connects a bank feed, links an account and its transactions import themselves', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByLabel('Email').fill(`feeds-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Workspace name').fill('Feeds household');
  await page.getByRole('radio', { name: /Household/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();
  const base = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');

  await page.goto(`${base}/settings?tab=bank-feeds`);
  const card = page.getByTestId('bank-feeds-card');
  await expect(card.getByRole('heading', { name: 'Bank feeds' })).toBeVisible();

  // At SimpleFIN Bridge (the synthetic one): a setup token for Montra, pasted once.
  const token = await (await page.request.get(`${SIMPLEFIN}/__token`)).text();
  await card.getByLabel('Setup token').fill(token);
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByTestId('bank-feeds-status')).toHaveText('Connected');
  await expect(card.getByText('Checking …1234')).toBeVisible();
  await expect(card.getByText('Rewards Card …9876')).toBeVisible();
  // The token is never shown back.
  await expect(card.getByLabel('Setup token')).toHaveCount(0);
  expect(await page.content()).not.toContain(token);

  // Create a Montra account for the checking account: linked, from 90 days back (no history yet).
  const checking = card.getByTestId('bank-feeds-account').filter({ hasText: 'Checking …1234' });
  await checking.getByRole('button', { name: 'Create account' }).click();
  await checking.getByRole('button', { name: 'Create and link' }).click();
  await expect(checking.getByText('Linked to Checking …1234')).toBeVisible();

  // Linking makes the feed due at once; the worker syncs and, with nothing to decide, imports it.
  await expect
    .poll(
      async () => {
        await page.goto(`${base}/statements`);
        return page
          .getByRole('row')
          .filter({ hasText: 'SimpleFIN · Checking …1234' })
          .innerText()
          .catch(() => '');
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toContain('Imported');
  // Nothing waits in Review for it.
  await page.goto(`${base}/review`);
  await expect(page.getByTestId('feed-imports')).toHaveCount(0);

  // Disconnecting forgets the access; the imported transactions stay.
  await page.goto(`${base}/settings?tab=bank-feeds`);
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await expect(card.getByLabel('Setup token')).toBeVisible();
  await page.goto(`${base}/statements`);
  await expect(page.getByRole('row').filter({ hasText: 'SimpleFIN · Checking …1234' })).toContainText(
    'Imported',
  );
});
