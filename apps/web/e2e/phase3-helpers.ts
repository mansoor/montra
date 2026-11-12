import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page } from '@playwright/test';

/**
 * Shared steps for the Phase 3 specs. The API and worker run with AI_PROVIDER=fake, which categorizes by
 * keyword against the category names (e.g. STARBUCKS → Dining out, SHELL → Fuel & transport).
 */
export async function onboardHousehold(page: Page, email: string, account: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Workspace name').fill('AI household');
  await page.getByRole('radio', { name: /Household/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();
  await nav(page, 'Accounts');
  // Home has an Add account link too, so wait until this is the page in front.
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Add account' }).click();
  await page.getByLabel('Name').fill(account);
  await page.getByLabel('Current balance').fill('2,500.00');
  await page.getByLabel('As of').fill('2026-10-01');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: account })).toBeVisible();
}

/** A sidebar link by the start of its name, so a count badge still matches ("Review 3") but "Month in review" doesn't. */
export const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: new RegExp(`^${name}`, 'i') })
    .click();

/** Settings → AI: optionally change the mode and the review threshold, then save. */
export async function setAi(page: Page, opts: { mode?: RegExp; threshold?: number }) {
  // Settings → AI: the AI group under Settings in the menu, then its AI tab.
  await nav(page, 'Settings');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'AI', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'AI', exact: true })
    .click();
  await expect(page.getByRole('radiogroup', { name: 'Where AI runs' })).toBeVisible();
  if (opts.mode) await page.getByRole('radio', { name: opts.mode }).check();
  if (opts.threshold !== undefined) await page.locator('#ai-threshold').fill(String(opts.threshold));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();
}

/** Imports a small CSV into the account whose page is open and commits it. */
export async function importCsv(page: Page, account: string, name: string, csv: string, rows: number) {
  await nav(page, 'Home');
  await page.getByRole('link', { name: account }).first().click();
  await page.getByRole('link', { name: 'Import statement' }).click();
  await page.getByLabel('Choose statement files').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByRole('button', { name: 'Upload and preview' }).click();
  await expect(page.getByTestId('preview-row')).toHaveCount(rows, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Import transactions' }).click();
  await expect(page.getByTestId('import-summary')).toContainText('Import complete', { timeout: 30_000 });
}

/** The fake provider's document photo: a 1×1 PNG with the text in a `montra:receipt` tEXt chunk. */
export function fakeDocumentPng(text: string): Buffer {
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
