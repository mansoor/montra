import { expect, test } from '@playwright/test';

/**
 * ADR-0054 §2, §6, §13 (VLT-01, VLT-02, VLT-07): an owner connects the workspace to a Family Document Vault from
 * Settings → Storage with the API key the vault generates for Montra (vault 0.9.0-dev.63), and chooses what each group
 * does. The API runs with FAMILY_VAULT_FAKE=on (playwright.config.ts), so the vault is the vault's own fake inside the
 * API process; the dev-only routes stand in for the vault's owner connecting Montra there and generating its keys. No
 * real vault is used. Sending itself is tested against the same fake in the API's own tests
 * (family-vault-sending.test.ts): the e2e worker is another process, without the API's in-process fake.
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

  // In the vault (its fake): its owner connects Montra and generates an API key, shown with its secret once.
  type Key = { appId: string; clientId: string; code: string; secret: string };
  const generated = async (path: string) => {
    const res = await page.request.post(path, { data: {} });
    expect(res.ok()).toBe(true);
    return (await res.json()) as Key;
  };
  const first = await generated('/api/v1/dev/fake-vault/apps');
  expect(first.code).toMatch(/^fdvapp2\./);

  // In Montra: no key to make or copy any more, only what the vault gave to paste. The connection string (with the
  // line breaks people paste) and, as it doesn't include it, the secret.
  await card.getByRole('button', { name: 'Connect Family Document Vault' }).click();
  await expect(card.getByTestId('vault-public-key')).toHaveCount(0);
  await expect(card.getByText('generate an API key for it', { exact: false })).toBeVisible();
  const secretField = card.getByLabel("Client secret (fdvs_…), if the connection string doesn't include it");
  await expect(secretField).toHaveAttribute('type', 'password');
  await card
    .getByRole('textbox', { name: 'Connection string from the vault' })
    .fill(`${first.code.slice(0, 20)}\n${first.code.slice(20)}`);
  // Without the secret, the API says what is missing, in words.
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByText('doesn’t include the secret', { exact: false })).toBeVisible();
  await secretField.fill(first.secret);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByTestId('vault-status')).toHaveText('Connected to The fake family');
  await expect(card.getByTestId('vault-where')).toContainText('fake.example');
  // Montra acts as itself in the vault (APP8), and the card says what its key is, never its secret.
  await expect(card.getByTestId('vault-acts-as')).toHaveText('Itself, as Montra');
  await expect(card.getByTestId('vault-key')).toContainText('Expires on');
  await expect(card.getByTestId('vault-key')).toContainText('send documents');
  expect(await page.content()).not.toContain(first.secret);

  await card.getByRole('button', { name: 'Check again' }).click();
  await expect(card.getByTestId('vault-status')).toHaveText('Connected to The fake family');

  // ADR-0054 §6 (PR 3): what each group does. Nothing goes until a sent group is mapped to one of the vault's kinds.
  const sending = card.getByTestId('vault-sending');
  await expect(sending.getByTestId('vault-unmapped')).toContainText('Receipts');
  await expect(sending.getByRole('combobox', { name: 'What happens to Receipts' })).toHaveValue(
    'sent_keep_copy',
  );
  // All three modes (PR 5b), sending without a local copy among them.
  await expect(
    sending.getByRole('combobox', { name: 'What happens to Receipts' }).locator('option'),
  ).toHaveText(["Don't send", 'Send, and keep a copy in Montra', "Send, and don't keep a copy in Montra"]);
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

  // Receipts go without a local copy only after §5a's warning. From what is saved, so only this change is asked about.
  await page.goto(`${base}/settings?tab=storage`);
  await expect(sending.getByRole('combobox', { name: 'What happens to Payslips' })).toHaveValue(
    'sent_keep_copy',
  );
  await sending.getByRole('combobox', { name: 'What happens to Receipts' }).selectOption('sent_no_copy');
  let noCopyWarning = '';
  page.once('dialog', (d) => {
    noCopyWarning = d.message();
    void d.accept();
  });
  await sending.getByRole('button', { name: 'Save' }).click();
  await expect(sending.getByText('Saved.', { exact: false })).toBeVisible();
  expect(noCopyWarning).toContain('Montra will remove its own copy of these documents');
  await expect(sending.getByRole('combobox', { name: 'What happens to Receipts' })).toHaveValue(
    'sent_no_copy',
  );

  // Nothing has been sent from this new workspace, and there is nothing already in Montra to send.
  await expect(sending.getByText('Nothing has been sent yet.')).toBeVisible();
  await sending.getByRole('button', { name: 'Send existing documents…' }).click();
  await expect(sending.getByTestId('vault-existing-count')).toContainText('there are none');

  // ADR-0054 §9, §10 (PR 4). This vault lets Montra send and nothing more: it doesn't read what the vault did with its
  // documents, and "Also delete it in the vault" isn't offered.
  await expect(sending.getByTestId('vault-feed')).toContainText("the vault hasn't allowed it");
  await expect(sending.getByTestId('vault-delete-with-montra')).toBeDisabled();
  // "Open in the vault" goes through the web app's own route, which makes a link only for a click; for a file that
  // isn't there it says so in words, and makes none.
  await page.goto(`${base}/vault/00000000-0000-4000-8000-000000000001/open?mode=view`);
  await expect(page.getByTestId('vault-open-problem')).toContainText(
    "That file isn't here, or you can't see it.",
  );
  expect(page.url()).toContain('problem=not_found');

  // The saves above refresh the page's data in the background; start the key change from what is saved.
  await page.goto(`${base}/settings?tab=storage`);
  await expect(card.getByTestId('vault-status')).toHaveText('Connected to The fake family');

  // Replace the key, owner-driven: the owner generates a new key in the vault and pastes it; Montra checks it with the
  // vault and switches. Started and left first, then done with the new key's client ID and secret.
  await card.getByRole('button', { name: 'Replace the key' }).click();
  const newKey = card.getByTestId('vault-new-key');
  await expect(newKey).toBeVisible();
  await newKey.getByRole('button', { name: 'Keep the current key' }).click();
  await expect(card.getByTestId('vault-new-key')).toHaveCount(0);
  const second = await generated(`/api/v1/dev/fake-vault/apps/${first.appId}/keys`);
  await card.getByRole('button', { name: 'Replace the key' }).click();
  await newKey
    .getByRole('textbox', { name: "The new key's connection string, or its client ID" })
    .fill(second.clientId);
  await newKey
    .getByLabel("Client secret (fdvs_…), if the connection string doesn't include it")
    .fill(second.secret);
  await newKey.getByRole('button', { name: 'Use the new key' }).click();
  await expect(card.getByText('Montra uses the new key now.', { exact: false })).toBeVisible();
  await expect(card.getByTestId('vault-status')).toHaveText('Connected to The fake family');
  expect(await page.content()).not.toContain(second.secret);

  // Disconnect: the key is thrown away.
  page.once('dialog', (d) => d.accept());
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await expect(card.getByRole('button', { name: 'Connect Family Document Vault' })).toBeVisible();
});
