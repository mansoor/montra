import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { fakeDocumentPng, nav, onboardHousehold } from './phase3-helpers';

/**
 * Phase 5: a receipt photo is read, matched to its card line and splits it by item (requirements §3.5,
 * exit criterion 1); editing a line's category in review re-splits the transaction (RCP-06). The API and
 * worker run with AI_PROVIDER=fake, which reads the receipt text carried in the PNG.
 */

const WALMART = [
  'WALMART SUPERCENTER #1234',
  '10/05/2026 14:32',
  'GV 2% MLK GAL          3.48 N',
  'BANANAS                1.62 N',
  'ONN USB-C CHRGR       12.88 T',
  'TS MENS TEE            8.98 T',
  'SUBTOTAL              26.96',
  'TAX                    1.75',
  'TOTAL                 28.71',
  'CARD **** 1234',
].join('\n');

test('a Walmart receipt splits its card line into groceries, electronics and clothing', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `receipts-${Date.now()}@example.com`, 'Everyday checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  // The fake provider reads the text carried in the photo: let photos go to the AI (Settings → AI).
  await page.request.patch(`/api/v1/workspaces/${workspaceId}/ai/settings`, {
    data: { allowReceiptImagesToLlm: true },
  });

  // The card line, as a statement import would record it.
  const accounts = await (await page.request.get(`/api/v1/workspaces/${workspaceId}/accounts`)).json();
  const charge = await page.request.post(`/api/v1/workspaces/${workspaceId}/transactions`, {
    data: {
      date: '2026-10-06',
      accountId: accounts.data[0].id,
      amount: { amount: '-2871', currency: 'USD' },
      payee: 'WALMART SUPERCENTER #1234',
    },
  });
  expect(charge.status()).toBe(201);

  // Upload the photo (TXN-08 on the web) and wait for the worker to read and match it (IMP-11).
  const file = join(mkdtempSync(join(tmpdir(), 'montra-receipt-')), 'walmart.png');
  writeFileSync(file, fakeDocumentPng(WALMART));
  await nav(page, 'Receipts');
  await expect(page.getByRole('heading', { name: 'Receipts', exact: true })).toBeVisible();
  await page.getByLabel('Choose files').setInputFiles(file);
  await page.getByRole('button', { name: 'Read receipt' }).click();
  await expect(page).toHaveURL(/\/receipts\/[0-9a-f-]+$/);
  await expect(page.getByText('Matched', { exact: true })).toBeVisible({ timeout: 30_000 });

  // The documented splits (RCP-03/04): tax only on the taxable lines.
  const splits = page.getByTestId('receipt-split');
  await expect(splits).toHaveText([/Groceries\s*\$5\.10/, /Electronics\s*\$13\.91/, /Clothing\s*\$9\.70/]);
  await expect(page.getByRole('img', { name: 'Receipt page 1' })).toBeVisible();

  // Review (RCP-06): the T-shirt was a gift; the transaction follows.
  await page.getByLabel('Category for TS MENS TEE').selectOption({ label: 'Gifts' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();
  await expect(splits).toHaveText([/Groceries\s*\$5\.10/, /Electronics\s*\$13\.91/, /Gifts\s*\$9\.70/]);

  await page.getByRole('link', { name: 'Open the transaction' }).click();
  await expect(page).toHaveURL(/\/transactions\/[0-9a-f-]+$/);
  // The posted lines (DE-07) follow the receipt groups.
  const journal = page.locator('section[aria-labelledby="journal-heading"]');
  await expect(journal.getByText('Gifts')).toBeVisible();
  await expect(journal.getByText('Electronics')).toBeVisible();

  // The receipt is in the matched list and found by what is on it (RCP-10).
  await nav(page, 'Receipts');
  await page.getByLabel('Search receipts').fill('chrgr');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('receipt-row')).toHaveCount(1);
  await expect(page.getByTestId('receipt-row')).toContainText('Matched');
});

test('a purchase abroad on a home-currency card records the original amount and the fee (CUR-03)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await onboardHousehold(page, `abroad-${Date.now()}@example.com`, 'Everyday checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  // The fake provider reads the text carried in the photo: let photos go to the AI (Settings → AI).
  await page.request.patch(`/api/v1/workspaces/${workspaceId}/ai/settings`, {
    data: { allowReceiptImagesToLlm: true },
  });
  const api = `/api/v1/workspaces/${workspaceId}`;
  const accounts = await (await page.request.get(`${api}/accounts`)).json();
  const categories = await (await page.request.get(`${api}/categories`)).json();
  const dining = categories.data.find((c: { name: string }) => c.name === 'Dining out').id;
  const created = await page.request.post(`${api}/transactions`, {
    data: {
      date: '2026-10-30',
      accountId: accounts.data[0].id,
      amount: { amount: '-4491', currency: 'USD' },
      payee: 'Le Petit Bistro',
      categoryId: dining,
    },
  });
  const { id } = await created.json();

  await page.goto(`/w/${workspaceId}/transactions/${id}`);
  await page.getByText('Paid in another currency?').click();
  await page.getByLabel('Amount on the receipt').fill('40.00');
  await page.getByLabel('Currency', { exact: true }).fill('EUR');
  await page.getByLabel('Foreign transaction fee (USD)').fill('1.31');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(page.getByText(/^Saved\. The rate comes from the charge/)).toBeVisible();

  const fx = page.locator('section[aria-labelledby="fx-title"]');
  await expect(fx).toContainText('€40.00');
  await expect(fx).toContainText('1.09');
  await expect(fx).toContainText('from the charge');
  await expect(fx).toContainText('$1.31');
  const journal = page.locator('section[aria-labelledby="journal-heading"]');
  await expect(journal.getByText('Bank fees')).toBeVisible();
});

test('a foreign receipt matches its home-currency card line within ±3% and keeps the actual rate', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The ECB rate for the day, loaded the way the fx.daily job stores it (app.upsert_fx_rates, ADR-0014).
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra',
  });
  await db.connect();
  try {
    await db.query(`select app.upsert_fx_rates('ecb', $1::jsonb)`, [
      JSON.stringify([{ date: '2026-10-30', base: 'EUR', quote: 'USD', rate: '1.0912' }]),
    ]);
  } finally {
    await db.end();
  }

  await onboardHousehold(page, `fx-receipt-${Date.now()}@example.com`, 'Everyday checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  // The fake provider reads the text carried in the photo: let photos go to the AI (Settings → AI).
  await page.request.patch(`/api/v1/workspaces/${workspaceId}/ai/settings`, {
    data: { allowReceiptImagesToLlm: true },
  });
  const api = `/api/v1/workspaces/${workspaceId}`;
  const accounts = await (await page.request.get(`${api}/accounts`)).json();
  const charge = await page.request.post(`${api}/transactions`, {
    data: {
      date: '2026-10-31',
      accountId: accounts.data[0].id,
      amount: { amount: '-4360', currency: 'USD' },
      payee: 'GALERIES LAFAYETTE PARIS FR',
    },
  });
  const { id: transactionId } = await charge.json();

  const file = join(mkdtempSync(join(tmpdir(), 'montra-receipt-')), 'paris.png');
  writeFileSync(
    file,
    fakeDocumentPng(
      ['GALERIES LAFAYETTE', '2026-10-30', 'CURRENCY EUR', 'FOULARD SOIE   40,00', 'TOTAL   40,00'].join(
        '\n',
      ),
    ),
  );
  await nav(page, 'Receipts');
  await page.getByLabel('Choose files').setInputFiles(file);
  await page.getByRole('button', { name: 'Read receipt' }).click();
  await expect(page.getByText('Matched', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Exit criterion 2: €40.00 at the day's 1.0912 would be $43.65; the $43.60 charge is −0.11% off. The
  // transaction keeps the original amount and the rate actually charged.
  await page.getByRole('link', { name: 'Open the transaction' }).click();
  await expect(page).toHaveURL(new RegExp(`/transactions/${transactionId}$`));
  const fx = page.locator('section[aria-labelledby="fx-title"]');
  await expect(fx).toContainText('€40.00');
  await expect(fx).toContainText('1.09');
  await expect(fx).toContainText('from the charge');
});
