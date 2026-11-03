import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { nav, onboardHousehold } from './phase3-helpers';

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

/** The fake provider's receipt photo: a 1×1 PNG with the text in a `montra:receipt` tEXt chunk. */
function fakeReceiptPng(text: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    chunk('tEXt', Buffer.from(`montra:receipt\0${Buffer.from(text).toString('base64')}`, 'latin1')),
    chunk('IDAT', deflateSync(Buffer.from([0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a Walmart receipt splits its card line into groceries, electronics and clothing', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `receipts-${Date.now()}@example.com`, 'Everyday checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;

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
  writeFileSync(file, fakeReceiptPng(WALMART));
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
  await page.getByLabel('Category for TS MENS TEE').selectOption({ label: 'Gifts & donations' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();
  await expect(splits).toHaveText([
    /Groceries\s*\$5\.10/,
    /Electronics\s*\$13\.91/,
    /Gifts & donations\s*\$9\.70/,
  ]);

  await page.getByRole('link', { name: 'Open the transaction' }).click();
  await expect(page).toHaveURL(/\/transactions\/[0-9a-f-]+$/);
  // The posted lines (DE-07) follow the receipt groups.
  const journal = page.locator('section[aria-labelledby="journal-heading"]');
  await expect(journal.getByText('Gifts & donations')).toBeVisible();
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
