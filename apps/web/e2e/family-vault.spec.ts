import { expect, test } from '@playwright/test';

/**
 * ADR-0054 §2, §6, §13 (VLT-01, VLT-02, VLT-07): an owner connects the workspace to a Family Document Vault from
 * Settings → Storage and chooses what each group does. The API runs with FAMILY_VAULT_FAKE=on (playwright.config.ts),
 * so the vault is the vault's own fake inside the API process; the dev-only route stands in for the vault's owner
 * registering Montra's key there. No real vault is used. Sending itself is tested against the same fake in the API's
 * own tests (family-vault-sending.test.ts): the e2e worker is another process, without the API's in-process fake.
 */
test('an owner connects the Family Document Vault, chooses what is sent, replaces the key and disconnects', async ({
  page,
}) => {
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
  const firstKey = await key.inputValue();
  const code = await register(firstKey);

  // Step 3: paste it, with the line breaks people paste.
  await card
    .getByRole('textbox', { name: 'Connection code from the vault' })
    .fill(`${code.slice(0, 20)}\n${code.slice(20)}`);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByTestId('vault-status')).toHaveText('Connected to The fake family');
  await expect(card.getByTestId('vault-where')).toContainText('fake.example');

  await card.getByRole('button', { name: 'Check again' }).click();
  await expect(card.getByTestId('vault-status')).toHaveText('Connected to The fake family');

  // ADR-0054 §6 (PR 3): what each group does. Nothing goes until a sent group is mapped to one of the vault's kinds.
  const sending = card.getByTestId('vault-sending');
  await expect(sending.getByTestId('vault-unmapped')).toContainText('Receipts');
  await expect(sending.getByRole('combobox', { name: 'What happens to Receipts' })).toHaveValue(
    'sent_keep_copy',
  );
  // Sending without a local copy isn't offered yet: Montra keeps its copy of everything it sends.
  await expect(
    sending.getByRole('combobox', { name: 'What happens to Receipts' }).locator('option'),
  ).toHaveText(["Don't send", 'Send, and keep a copy in Montra']);
  await sending
    .getByRole('combobox', { name: 'What Receipts are filed as in the vault' })
    .selectOption('utility_bill');
  await sending.getByRole('combobox', { name: 'What happens to Statements' }).selectOption('not_sent');
  // Bills start with the vault's obvious kind for them.
  await expect(sending.getByRole('combobox', { name: 'What Bills are filed as in the vault' })).toHaveValue(
    'utility_bill',
  );
  await sending.getByRole('button', { name: 'Save' }).click();
  await expect(sending.getByText('Saved.', { exact: false })).toBeVisible();
  await expect(sending.getByTestId('vault-unmapped')).toHaveCount(0);

  // Payslips go only after the warning, and only an owner turns them on.
  await sending.getByRole('combobox', { name: 'What happens to Payslips' }).selectOption('sent_keep_copy');
  await sending
    .getByRole('combobox', { name: 'What Payslips are filed as in the vault' })
    .selectOption('utility_bill');
  let warning = '';
  page.once('dialog', (d) => {
    warning = d.message();
    void d.accept();
  });
  await sending.getByRole('button', { name: 'Save' }).click();
  await expect(sending.getByText('Saved.', { exact: false })).toBeVisible();
  expect(warning).toContain('Where they go and who can see them there is set in the vault');
  await expect(sending.getByRole('combobox', { name: 'What happens to Payslips' })).toHaveValue(
    'sent_keep_copy',
  );

  // Nothing has been sent from this new workspace, and there is nothing already in Montra to send.
  await expect(sending.getByText('Nothing has been sent yet.')).toBeVisible();
  await sending.getByRole('button', { name: 'Send existing documents…' }).click();
  await expect(sending.getByTestId('vault-existing-count')).toContainText('there are none');

  // Replace the key: a new public key to register, the current one signing until then. Cancelled here.
  page.once('dialog', (d) => d.accept());
  await card.getByRole('button', { name: 'Replace the key' }).click();
  const newKey = card.getByTestId('vault-new-key');
  await expect(newKey.getByTestId('vault-public-key')).toHaveValue(/^ed25519:/);
  expect(await newKey.getByTestId('vault-public-key').inputValue()).not.toBe(firstKey);
  await newKey.getByRole('button', { name: 'Keep the current key' }).click();
  await expect(card.getByTestId('vault-new-key')).toHaveCount(0);

  // Disconnect: the key is thrown away.
  page.once('dialog', (d) => d.accept());
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await expect(card.getByRole('button', { name: 'Connect Family Document Vault' })).toBeVisible();
});
