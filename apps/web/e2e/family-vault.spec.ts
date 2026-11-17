import { expect, test } from '@playwright/test';

/**
 * ADR-0054 §2, §13 (VLT-01): an owner connects the workspace to a Family Document Vault from Settings → Storage. The
 * API runs with FAMILY_VAULT_FAKE=on (playwright.config.ts), so the vault is the vault's own fake inside the API
 * process; the dev-only route stands in for the vault's owner registering Montra's key there. No real vault is used.
 */
test('an owner connects the Family Document Vault, replaces the key and disconnects', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByLabel('Email').fill(`vault-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Workspace name').fill('Vault household');
  await page.getByRole('radio', { name: /Household/ }).check();
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Net position' })).toBeVisible();
  const base = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');

  await page.goto(`${base}/settings?tab=storage`);
  const card = page.getByTestId('vault-card');
  await expect(card.getByRole('heading', { name: 'Family Document Vault' })).toBeVisible();

  // Step 1: Montra makes the key, and shows only its public half.
  await card.getByRole('button', { name: 'Connect Family Document Vault' }).click();
  const key = card.getByTestId('vault-public-key');
  await expect(key).toHaveValue(/^ed25519:/);
  await expect(card.getByTestId('vault-status')).toHaveText('Waiting for the code');

  // Step 2, in the vault (its fake): register the key and get the code.
  const register = async (publicKey: string) => {
    const res = await page.request.post('/api/v1/dev/fake-vault/apps', { data: { publicKey } });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { code: string }).code;
  };
  const code = await register(await key.inputValue());

  // Step 3: paste it, with the line breaks people paste.
  await card.getByLabel('Connection code from the vault').fill(`${code.slice(0, 20)}\n${code.slice(20)}`);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByTestId('vault-status')).toHaveText('Connected to The fake family');
  await expect(card.getByTestId('vault-where')).toContainText('fake.example');
  await expect(card.getByText('Nothing is sent yet.', { exact: false })).toBeVisible();

  await card.getByRole('button', { name: 'Check again' }).click();
  await expect(card.getByTestId('vault-status')).toHaveText('Connected to The fake family');

  // Replace the key: a new public key to register, the current one signing until then. Cancelled here.
  page.once('dialog', (d) => d.accept());
  await card.getByRole('button', { name: 'Replace the key' }).click();
  const newKey = card.getByTestId('vault-new-key');
  await expect(newKey.getByTestId('vault-public-key')).toHaveValue(/^ed25519:/);
  expect(await newKey.getByTestId('vault-public-key').inputValue()).not.toBe(await key.inputValue());
  await newKey.getByRole('button', { name: 'Keep the current key' }).click();
  await expect(card.getByTestId('vault-new-key')).toHaveCount(0);

  // Disconnect: the key is thrown away.
  page.once('dialog', (d) => d.accept());
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await expect(card.getByRole('button', { name: 'Connect Family Document Vault' })).toBeVisible();
});
