import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fakeDocumentPng, nav, onboardHousehold } from './phase3-helpers';

/**
 * ADR-0048 §4 on the web: Budget → Bills → "Add a bill", typed in or uploaded and read like the phone's scan. A bill
 * for a business's provider becomes that business's vendor bill. The API and worker run with AI_PROVIDER=fake, which
 * reads the text carried in the PNG.
 */
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function billsTab(page: Page, email: string) {
  await onboardHousehold(page, email, 'Joint checking');
  const ws = `/api/v1/workspaces/${new URL(page.url()).pathname.split('/')[2]!}`;
  await nav(page, 'Budget');
  await page.getByRole('button', { name: 'Create budget' }).click();
  await expect(page.getByRole('heading', { name: 'Household budget' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Budget sections' })
    .getByRole('link', { name: 'Bills' })
    .click();
  await expect(page.getByRole('heading', { name: 'Bill providers' })).toBeVisible();
  return ws;
}

/** WCAG 2.2 AA in the open dialog, as the accessibility spec checks pages. */
async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .include('dialog[open]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);
}

/** The lists re-render after `router.refresh()`, which takes a while on a busy machine. */
const REFRESH = 20_000;

const billRow = (page: Page, name: string) =>
  page.getByTestId('household-bills').getByRole('row', { name: new RegExp(name) });

test('a bill typed in shows on the Bills tab, and a business provider files a vendor bill', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const ws = await billsTab(page, `bills-typed-${Date.now()}@example.com`);
  const due = inDays(10);

  // A provider on the budget first, with the existing form.
  const addProvider = page.getByRole('region', { name: 'Add a provider' });
  await addProvider.getByLabel('Provider').fill('SDG&E');
  await addProvider.getByRole('button', { name: 'Add provider' }).click();
  await expect(page.getByTestId('biller-row').filter({ hasText: 'SDG&E' })).toBeVisible({ timeout: REFRESH });

  // Typed in: the budget's provider is offered, and a missing amount or date is named.
  await page.getByRole('button', { name: 'Add a bill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a bill' });
  await dialog.getByRole('radio', { name: 'Type it in' }).click();
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue(/.+/);
  await dialog.getByRole('button', { name: 'File the bill' }).click();
  await expect(dialog.getByText('Enter an amount', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Enter the due date')).toBeVisible();
  await expect(dialog.getByLabel('Amount due (USD)')).toHaveAttribute('aria-invalid', 'true');
  await expectAccessible(page);
  await dialog.getByLabel('Amount due (USD)').fill('84.12');
  await dialog.getByLabel('Due date').fill(due);
  await dialog.getByRole('button', { name: 'File the bill' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Filed the SDG&E bill' })).toBeVisible();
  await expect(billRow(page, 'SDG&E')).toContainText('$84.12', { timeout: REFRESH });
  // A bill filed wrongly (by hand, or automatically once the provider is learned) is voided from the list.
  await billRow(page, 'SDG&E').getByRole('button', { name: 'Void the SDG&E bill' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Voided the SDG&E bill.' })).toBeVisible();
  await expect(billRow(page, 'SDG&E')).toContainText('Void', { timeout: REFRESH });
  await expect(billRow(page, 'SDG&E').getByRole('button', { name: 'Void the SDG&E bill' })).toHaveCount(0);

  // A provider that isn't on the budget yet is added on the category chosen.
  await page.getByRole('button', { name: 'Add a bill' }).click();
  await dialog.getByRole('radio', { name: 'Type it in' }).click();
  await dialog.getByLabel('Provider', { exact: true }).selectOption({ label: 'New provider…' });
  await dialog.getByLabel("New provider's name").fill('City Water');
  await dialog.getByLabel('Amount due (USD)').fill('40');
  await dialog.getByLabel('Due date').fill(inDays(12));
  await dialog.getByLabel('Bill date (optional)').fill(inDays(-3));
  await dialog.getByRole('button', { name: 'File the bill' }).click();
  await expect(dialog).toBeHidden();
  await expect(billRow(page, 'City Water')).toContainText('$40.00', { timeout: REFRESH });
  await expect(page.getByTestId('biller-row').filter({ hasText: 'City Water' })).toBeVisible({
    timeout: REFRESH,
  });

  // A provider on a business's books: the server files a vendor bill there, and says so.
  const biz = await page.request.post(`${ws}/entities`, {
    data: { type: 'business', name: 'Studio', businessType: 'sole_prop' },
  });
  expect(biz.status()).toBe(201);
  const bizId = (await biz.json()).id as string;
  const cats = (await (await page.request.get(`${ws}/categories?entityId=${bizId}`)).json()).data as {
    id: string;
    name: string;
    type: string;
  }[];
  const expense =
    cats.find((c) => /utilit/i.test(c.name) && c.type === 'expense') ??
    cats.find((c) => c.type === 'expense')!;
  expect(
    (
      await page.request.post(`${ws}/billers`, { data: { categoryId: expense.id, name: 'Studio Power' } })
    ).status(),
  ).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: 'Add a bill' }).click();
  await dialog.getByRole('radio', { name: 'Type it in' }).click();
  await dialog.getByLabel('Provider', { exact: true }).selectOption({ label: 'Studio Power' });
  await dialog.getByLabel('Amount due (USD)').fill('200');
  await dialog.getByLabel('Due date').fill(due);
  await dialog.getByRole('button', { name: 'File the bill' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Studio Power is on Studio's books, so the bill was filed there as a vendor bill."),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open its bills' }).click();
  await expect(page).toHaveURL(new RegExp(`/business/${bizId}/bills`));
  await expect(page.getByText('Studio Power').first()).toBeVisible();
});

test('an uploaded bill is read, checked and filed from the same reading', async ({ page }) => {
  test.setTimeout(120_000);
  const ws = await billsTab(page, `bills-upload-${Date.now()}@example.com`);
  const due = inDays(10);
  // The fake provider reads the text carried in the photo: let documents go to the AI (Settings → AI).
  await page.request.patch(`${ws}/ai/settings`, { data: { allowDocumentsToLlm: true } });
  const cats = (await (await page.request.get(`${ws}/categories`)).json()).data as {
    id: string;
    name: string;
  }[];
  const phone = cats.find((c) => c.name === 'Phone & internet') ?? cats.find((c) => c.name === 'Utilities')!;
  const comcast = await page.request.post(`${ws}/billers`, {
    data: { categoryId: phone.id, name: 'Comcast', accountLast4: '4321' },
  });
  expect(comcast.status()).toBe(201);
  await page.reload();

  const file = join(mkdtempSync(join(tmpdir(), 'montra-bill-')), 'bill.png');
  writeFileSync(
    file,
    fakeDocumentPng(
      [
        'XFINITY',
        'ACCOUNT NUMBER 8774 1023 4321',
        'AMOUNT DUE $112.45',
        `DUE DATE ${due}`,
        'KIND internet_tv',
      ].join('\n'),
    ),
  );
  await page.getByRole('button', { name: 'Add a bill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a bill' });
  await expect(dialog.getByRole('radio', { name: 'Upload a PDF or photo' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dialog.getByLabel('Choose bill pages').setInputFiles(file);
  await dialog.getByRole('button', { name: 'Read the bill' }).click();

  // What was read, and the provider found by the account number's last four digits.
  const read = dialog.getByRole('region', { name: 'What the bill says' });
  await expect(read).toBeVisible({ timeout: 45_000 });
  await expect(read).toContainText('XFINITY');
  await expect(read).toContainText('$112.45');
  await expect(read).toContainText('Account ending 4321');
  await expect(dialog.getByText('Matched to Comcast by the account number.')).toBeVisible();
  await expect(dialog.getByLabel('Amount due (USD)')).toHaveValue('112.45');
  await expect(dialog.getByLabel('Due date')).toHaveValue(due);
  await expectAccessible(page);

  // Corrected before filing.
  await dialog.getByLabel('Amount due (USD)').fill('110.45');
  await dialog.getByRole('button', { name: 'File the bill' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Filed the Comcast bill' })).toBeVisible();
  await expect(billRow(page, 'Comcast')).toContainText('$110.45', { timeout: REFRESH });
  const bills = (await (await page.request.get(`${ws}/household-bills`)).json()).data;
  expect(bills).toContainEqual(
    expect.objectContaining({
      billerName: 'Comcast',
      amount: '11045',
      dueDate: due,
      fileIds: [expect.any(String)],
    }),
  );
});
