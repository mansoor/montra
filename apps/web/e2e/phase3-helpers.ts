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
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Add account' }).click();
  await page.getByLabel('Name').fill(account);
  await page.getByLabel('Current balance').fill('2,500.00');
  await page.getByLabel('As of').fill('2026-10-01');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { name: account })).toBeVisible();
}

export const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: false }).click();

/** Settings → AI: optionally change the mode and the review threshold, then save. */
export async function setAi(page: Page, opts: { mode?: RegExp; threshold?: number }) {
  await nav(page, 'Settings');
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
