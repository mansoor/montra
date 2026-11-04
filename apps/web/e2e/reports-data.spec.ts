import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { nav, onboardHousehold } from './phase3-helpers';

const today = new Date().toISOString().slice(0, 10);

/** A household with one account and two purchases today: $45.00 of dining out and $120.00 of groceries. */
async function seed(page: Page, email: string) {
  await onboardHousehold(page, email, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const accounts = (await (await page.request.get(`${ws}/accounts`)).json()).data as {
    id: string;
    name: string;
  }[];
  const accountId = accounts.find((a) => a.name === 'Joint checking')!.id;
  const categories = (await (await page.request.get(`${ws}/categories`)).json()).data as {
    id: string;
    name: string;
  }[];
  const spend = async (payee: string, amount: string, category: RegExp, memo?: string) => {
    const res = await page.request.post(`${ws}/transactions`, {
      data: {
        date: today,
        accountId,
        amount: { amount, currency: 'USD' },
        payee,
        categoryId: categories.find((c) => category.test(c.name))!.id,
        ...(memo ? { memo } : {}),
      },
    });
    expect(res.status()).toBe(201);
    return (await res.json()) as { id: string };
  };
  const cafe = await spend('Corner Cafe', '-4500', /^Dining out$/, 'birthday dinner');
  const mart = await spend('Fresh Mart', '-12000', /grocer/i);
  return { workspaceId, ws, base: `/w/${workspaceId}`, cafeId: cafe.id, martId: mart.id };
}

/** Phase 10: reports filter, drill down, save and export, and search and ask read the same books (RPT-01..06). */
test('reports drill down and export, and search and ask find the same money', async ({ page }) => {
  test.setTimeout(120_000);
  const { base } = await seed(page, `reports-${Date.now()}@example.com`);

  await nav(page, 'Reports');
  await page.getByRole('link', { name: 'Spending', exact: false }).first().click();
  const rows = page.getByTestId('report-row');
  await expect(rows.filter({ hasText: 'Dining out' })).toContainText('$45.00');
  await expect(page.getByTestId('report-total')).toContainText('$165.00');

  // A filter lives in the URL, so it survives a reload.
  const categoryField = page
    .getByRole('form', { name: 'Filters' })
    .locator('label', { has: page.locator('span', { hasText: /^Category$/ }) })
    .locator('select');
  await categoryField.selectOption({ label: 'Dining out' });
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/categoryIds=/);
  await expect(page.getByTestId('report-total')).toContainText('$45.00');
  await page.reload();
  await expect(page.getByTestId('report-total')).toContainText('$45.00');

  await page.getByLabel('Save as').fill('Eating out');
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.getByText('Report saved.')).toBeVisible();

  // The file holds what's on screen.
  const download = page.waitForEvent('download');
  await page.getByRole('group', { name: 'Export' }).getByRole('button', { name: 'CSV' }).click();
  const csv = readFileSync(await (await download).path(), 'utf8');
  expect(csv).toContain('Dining out');
  expect(csv).not.toContain('Fresh Mart');

  // The row leads to the transactions behind it.
  await rows.filter({ hasText: 'Dining out' }).getByRole('link').click();
  await expect(page.getByRole('link', { name: /Corner Cafe/ }).first()).toBeVisible();
  await expect(page.getByText('Fresh Mart')).toHaveCount(0);

  await page.goto(`${base}/reports`);
  await page.getByRole('link', { name: 'Eating out' }).click();
  await expect(page.getByTestId('report-total')).toContainText('$45.00');

  // Search from the header, with an amount, and into a note that's encrypted at rest.
  const box = page.getByRole('search').getByRole('searchbox');
  await box.fill('cafe >40');
  await box.press('Enter');
  await expect(page).toHaveURL(/search\?q=/);
  await expect(page.getByTestId('search-payee')).toContainText('Corner Cafe');
  await page.goto(`${base}/search?q=${encodeURIComponent('cafe >50')}`);
  await expect(page.getByText('Nothing found.')).toBeVisible();
  await page.goto(`${base}/search?q=birthday`);
  await expect(page.getByText('Corner Cafe').first()).toBeVisible();

  // The AI says what's being asked; the figure comes from the books.
  await nav(page, 'Ask');
  await page.getByLabel('Your question').fill('How much did I spend on dining out?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByTestId('ask-period')).toContainText('$45.00');
  await page.getByLabel('Your question').fill('What is the weather like?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByTestId('ask-unknown')).toBeVisible();
});

/** NOT-01: the inbox and what comes by which channel. The nightly checks themselves are covered in the API tests. */
test('a notification reaches the bell and the inbox, and preferences stick', async ({ page }) => {
  test.setTimeout(90_000);
  const { workspaceId, base } = await seed(page, `notify-${Date.now()}@example.com`);
  const me = await (await page.request.get('/api/v1/me')).json();
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra',
  });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(`select set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)`, [
      workspaceId,
      me.user?.id ?? me.id,
    ]);
    await db.query(
      `insert into app.notification (workspace_id, user_id, type, title, body, dedupe_key, email_status, push_status)
       values ($1, $2, 'bill_due', 'Water bill is due', 'Due on Friday', 'e2e:water', 'none', 'none')`,
      [workspaceId, me.user?.id ?? me.id],
    );
    await db.query('commit');
  } finally {
    await db.end();
  }

  await page.goto(base);
  await expect(page.getByTestId('notification-count')).toHaveText('1');
  await page.goto(`${base}/notifications`);
  const row = page.getByTestId('notification-row').filter({ hasText: 'Water bill is due' });
  await expect(row.getByLabel('Unread')).toBeVisible();
  await row.getByRole('button', { name: 'Mark read' }).click();
  await expect(row.getByLabel('Unread')).toHaveCount(0);
  await expect(page.getByTestId('notification-count')).toHaveCount(0);

  await page.goto(`${base}/settings?tab=notifications`);
  const email = page.getByRole('checkbox', { name: 'Rental reminders by Email' });
  const was = await email.isChecked();
  await email.setChecked(!was);
  await page.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Rental reminders by Email' })).toBeChecked({
    checked: !was,
  });
});

/** BAK-04, BAK-06, BAK-08: a password-protected backup comes back whole in a new workspace, and the trash gives things back. */
test('a backup restores into a new workspace with the same figures, and the trash gives things back', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { ws, base, martId } = await seed(page, `backup-${Date.now()}@example.com`);

  const removed = await page.request.delete(`${ws}/transactions/${martId}`);
  expect(removed.ok()).toBe(true);
  await page.goto(`${base}/trash`);
  const trashed = page.getByTestId('trash-row').filter({ hasText: 'Fresh Mart' });
  await expect(trashed).toBeVisible();
  await trashed.getByRole('button', { name: 'Restore Fresh Mart' }).click();
  await expect(page.getByText('Restored Fresh Mart.')).toBeVisible();
  await expect(trashed).toHaveCount(0);

  await page.goto(`${base}/settings?tab=data`);
  await expect(page.getByTestId('storage-used')).toBeVisible();
  const password = 'e2e backup passphrase';
  await page.getByLabel('Password (optional)').first().fill(password);
  await page.getByRole('button', { name: 'Back up now' }).click();
  const ready = page.getByTestId('export-row').filter({ hasText: 'Ready' });
  await expect(async () => {
    await page.reload();
    await expect(ready).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await expect(ready).toContainText('Password protected');
  const download = page.waitForEvent('download');
  await ready.getByRole('button', { name: 'Download' }).click();
  const file = await download;
  const path = await file.path();

  // Nothing changes until the preview is confirmed.
  await page.getByLabel('Backup file').setInputFiles({
    name: file.suggestedFilename(),
    mimeType: 'application/octet-stream',
    buffer: readFileSync(path),
  });
  await page
    .getByRole('form', { name: 'Check this backup' })
    .getByLabel('Password (optional)')
    .fill(password);
  await page.getByRole('button', { name: 'Check this backup' }).click();
  const preview = page.getByTestId('restore-preview');
  await expect(async () => {
    await page.reload();
    await expect(preview).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await expect(preview).toContainText('AI household');
  await expect(preview).toContainText('2 transactions');
  await preview.getByRole('radio', { name: 'A new workspace' }).check();
  await preview.getByRole('button', { name: 'Restore' }).click();
  const done = page.getByTestId('restore-done');
  await expect(async () => {
    await page.reload();
    await expect(done).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });

  const href = await done.getByRole('link', { name: 'Open it' }).getAttribute('href');
  const restored = `/api/v1/workspaces/${href!.split('/')[2]}`;
  expect(href).not.toContain(base);
  const total = async (w: string) =>
    (await (await page.request.get(`${w}/reports/catalog/spending?from=${today}&to=${today}`)).json()).totals
      .amount as string;
  expect(await total(restored)).toBe(await total(ws));
  await page.goto(href!);
  await expect(page.getByRole('link', { name: /Joint checking/ }).first()).toBeVisible();

  await page.goto(`${base}/settings?tab=security`);
  await expect(
    page.getByTestId('security-event').filter({ hasText: 'A backup or export was requested' }),
  ).not.toHaveCount(0);
});

/** BAK-09: leaving closes the account at once and can be undone. The purge itself is covered in the API tests. */
test('deleting an account closes it, and it can be kept', async ({ page }) => {
  test.setTimeout(90_000);
  const { base } = await seed(page, `leaving-${Date.now()}@example.com`);
  await page.goto(`${base}/settings?tab=data`);
  const form = page.getByRole('form', { name: 'Delete my account' });
  await expect(form.getByRole('button', { name: 'Delete my account' })).toBeDisabled();
  await form.getByLabel('Type DELETE to confirm').fill('DELETE');
  await form.getByRole('button', { name: 'Delete my account' }).click();
  await expect(page).toHaveURL(/account-deleting/);
  await expect(page.getByRole('heading', { name: 'This account is being deleted' })).toBeVisible();

  // Nothing else opens meanwhile.
  await page.goto(base);
  await expect(page).toHaveURL(/account-deleting/);

  await page.getByRole('button', { name: 'Keep my account' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();
});
