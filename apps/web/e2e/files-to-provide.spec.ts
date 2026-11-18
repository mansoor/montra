import { expect, test } from '@playwright/test';
import pg from 'pg';

/**
 * ADR-0054 §5a (VLT-11): Review → "Files to provide again". A file Montra no longer keeps a copy of, that the household's
 * Family Document Vault didn't give back, is listed with what it was and an Upload action; its count joins the Review
 * badge; uploading the paper again stores it under the same file and the entry goes. The vault itself isn't needed
 * here: the file is marked as the API marks one (sending, filing and the vault's refusal are tested against the
 * vault's own fake in the API's tests, family-vault-no-copy.test.ts).
 */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
]);

test('a file the vault didn’t give back is listed in Review, counted in its badge, and uploaded again', async ({
  page,
}) => {
  const email = `missing-${Date.now()}@example.com`;
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Workspace name').fill('Missing files household');
  await page.getByRole('radio', { name: /Household/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible({ timeout: 20_000 });
  const base = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');
  const workspaceId = base.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;

  // Set up straight against the API (dev sign-in), as a person's upload of a receipt's photo stores it.
  const api = `http://localhost:${process.env.E2E_API_PORT ?? 4000}/v1/workspaces/${workspaceId}`;
  const auth = { authorization: `Bearer dev:${email}` };
  const uploaded = await page.request.post(`${api}/receipts/files`, {
    headers: auth,
    multipart: { file: { name: 'Corner shop.png', mimeType: 'image/png', buffer: PNG } },
  });
  expect(uploaded.ok()).toBe(true);
  const fileId = ((await uploaded.json()) as { fileId: string }).fileId;

  // As the API marks one: held only by the vault, which didn't give it back.
  const me = (await (
    await page.request.get(`http://localhost:${process.env.E2E_API_PORT ?? 4000}/v1/me`, { headers: auth })
  ).json()) as { id?: string; user?: { id: string } };
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
      `update app.file set location = 'vault', storage_key = null, missing_since = now(),
                           missing_reason = 'Family Document Vault didn’t give this file back to Montra.'
        where id = $1`,
      [fileId],
    );
    await db.query('commit');
  } finally {
    await db.end();
  }

  await page.goto(`${base}/review`);
  const section = page.getByTestId('files-to-provide');
  await expect(section.getByRole('heading', { name: 'Files to provide again' })).toBeVisible();
  const entry = section.getByTestId('missing-file').filter({ hasText: 'Corner shop.png' });
  await expect(entry).toContainText('didn’t give this file back');
  await expect(page.getByTestId('review-badge')).toHaveText('1');

  await entry.getByLabel('Upload Corner shop.png again').setInputFiles({
    name: 'Corner shop again.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByText('Corner shop.png is back in Montra.')).toBeVisible();
  await expect(page.getByTestId('missing-file')).toHaveCount(0);
  const left = await (await page.request.get(`${ws}/missing-files`)).json();
  expect(left.data).toEqual([]);
});

test('a file provided again that repeats another file’s bytes warns first, and the person decides', async ({
  page,
}) => {
  const email = `missing-dup-${Date.now()}@example.com`;
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Workspace name').fill('Duplicate files household');
  await page.getByRole('radio', { name: /Household/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible({ timeout: 20_000 });
  const base = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');
  const workspaceId = base.split('/')[2]!;
  const api = `http://localhost:${process.env.E2E_API_PORT ?? 4000}/v1/workspaces/${workspaceId}`;
  const auth = { authorization: `Bearer dev:${email}` };
  const other = Buffer.concat([PNG, Buffer.from('another paper')]);
  const store = async (name: string, buffer: Buffer) => {
    const r = await page.request.post(`${api}/receipts/files`, {
      headers: auth,
      multipart: { file: { name, mimeType: 'image/png', buffer } },
    });
    expect(r.ok()).toBe(true);
    return ((await r.json()) as { fileId: string }).fileId;
  };
  await store('Kept here.png', other);
  const lost = await store('Lost paper.png', PNG);
  const me = (await (
    await page.request.get(`http://localhost:${process.env.E2E_API_PORT ?? 4000}/v1/me`, { headers: auth })
  ).json()) as { id?: string; user?: { id: string } };
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
      `update app.file set location = 'vault', storage_key = null, missing_since = now(),
                           missing_reason = 'Family Document Vault didn’t give this file back to Montra.'
        where id = $1`,
      [lost],
    );
    await db.query('commit');
  } finally {
    await db.end();
  }

  await page.goto(`${base}/review`);
  const entry = page.getByTestId('missing-file').filter({ hasText: 'Lost paper.png' });
  const pick = () =>
    entry.getByLabel('Upload Lost paper.png again').setInputFiles({
      name: 'Which one.png',
      mimeType: 'image/png',
      buffer: other,
    });

  // Cancel: nothing is uploaded, and the entry stays.
  const asked: string[] = [];
  page.once('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await pick();
  await expect(page.getByText('Nothing was uploaded.')).toBeVisible();
  expect(asked[0]).toContain('This looks like a duplicate of “Kept here.png”');
  await expect(entry).toBeVisible();

  // Upload anyway: stored, and the entry goes.
  page.once('dialog', (d) => void d.accept());
  await pick();
  await expect(page.getByText(/Lost paper\.png is back in Montra/)).toBeVisible();
  await expect(page.getByTestId('missing-file')).toHaveCount(0);
});
