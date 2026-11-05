import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeDocumentPng, nav, onboardHousehold } from './phase3-helpers';

/**
 * Phase 7: a payslip photo is read, checked against the photo and posted against the deposit already in the
 * account, so the pay counts once (PAY-03, PAY-04, PAY-05). Reports then split the money by member, each total
 * drilling down to its transactions (FAM-08, FAM-09). The API and worker run with AI_PROVIDER=fake, which reads
 * the text carried in the PNG.
 */
test('a payslip posts against its deposit and shows up by member', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardHousehold(page, `payslips-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const payDate = new Date().toISOString().slice(0, 10);
  const accounts = (await (await page.request.get(`${ws}/accounts`)).json()).data;
  const checking = accounts[0].id as string;
  // The fake provider reads the text carried in the photo: let documents go to the AI (Settings → AI).
  await page.request.patch(`${ws}/ai/settings`, { data: { allowDocumentsToLlm: true } });
  const member = await page.request.post(`${ws}/family-members`, {
    data: { name: 'Sam', relationship: 'spouse_partner' },
  });
  expect(member.status()).toBe(201);
  const deposit = await page.request.post(`${ws}/transactions`, {
    data: {
      date: payDate,
      accountId: checking,
      amount: { amount: '408000', currency: 'USD' },
      payee: 'ACME PAYROLL',
    },
  });
  expect(deposit.status()).toBe(201);

  // An employer first (PAY-01).
  await nav(page, 'Payslips');
  await expect(page.getByText('Add an employer or other income source first', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Add employer or income source' }).click();
  const form = page.getByRole('form', { name: 'Add employer or income source' });
  await form.getByLabel('Name', { exact: true }).fill('ACME Corp');
  await form.getByLabel('Member').selectOption({ label: 'Sam' });
  await form.getByRole('button', { name: 'Add employer or income source' }).click();
  await expect(page.getByTestId('employer-row').filter({ hasText: 'ACME Corp' })).toBeVisible();

  // Upload the photo (PAY-03) and wait for the worker to read it. Nothing posts until it's confirmed.
  await page
    .getByRole('navigation', { name: 'Payslip sections' })
    .getByRole('link', { name: 'Payslips' })
    .click();
  const file = join(mkdtempSync(join(tmpdir(), 'montra-payslip-')), 'payslip.png');
  writeFileSync(
    file,
    fakeDocumentPng(
      [
        'Employer: ACME Corp',
        `Pay date: ${payDate}`,
        'Regular salary   5,000.00 ytd 50,000.00',
        '401(k)   300.00',
        'Federal tax   620.00',
        'Net pay   4,000.00',
      ].join('\n'),
    ),
  );
  await page.getByLabel('Choose files').setInputFiles(file);
  await page.getByRole('button', { name: 'Read payslip' }).click();
  await expect(page).toHaveURL(/\/payslips\/[0-9a-f-]+$/);
  await expect(page.getByLabel('Amount for Federal tax')).toHaveValue('620.00', { timeout: 30_000 });
  await expect(page.getByRole('complementary', { name: 'The payslip' })).toBeVisible();

  // The photo's net pay was misread: the gap blocks posting until it's fixed.
  await expect(page.getByText("These lines don't add up to the net pay.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm and post' })).toBeDisabled();
  await page.getByLabel('Net pay', { exact: true }).fill('4,080.00');
  await expect(page.getByText('The lines add up to the net pay.')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and post' }).click();
  await expect(page.getByText('Posted against the deposit already in your account')).toBeVisible();
  await expect(page.getByText('Matched to a deposit')).toBeVisible();

  // The account holds the deposit once, and 401(k) money is in its own account.
  const after = (await (await page.request.get(`${ws}/accounts`)).json()).data;
  expect(after.find((a: { id: string }) => a.id === checking).balance.amount).toBe('658000');
  expect(after.find((a: { name: string }) => a.name === 'ACME Corp retirement').balance.amount).toBe('30000');

  // Reports by member: gross income for the earner, and withholding (FAM-08, PAY-06).
  await nav(page, 'By member');
  const sam = page.getByTestId('member-card').filter({ hasText: 'Sam' });
  await expect(sam.getByRole('link', { name: /Income.*\$5,000\.00/ })).toBeVisible();
  const summary = page.getByTestId('payslip-summary');
  await expect(summary.getByRole('row', { name: /Taxes withheld.*\$620\.00/ })).toBeVisible();
  await expect(summary.getByRole('row', { name: /Effective withholding rate.*12\.40%/ })).toBeVisible();

  // Any member total drills to its transactions (FAM-09).
  await sam.getByRole('link', { name: /Income/ }).click();
  await expect(page.getByText('Showing the transactions behind a number')).toBeVisible();
  await expect(page.getByText('ACME PAYROLL')).toBeVisible();

  // Home filters by member, and the budget offers a member's own (FAM-06, FAM-09).
  await nav(page, 'Home');
  await page.getByRole('navigation', { name: 'Show one member' }).getByRole('link', { name: 'Sam' }).click();
  await expect(page).toHaveURL(/memberId=/);
  await expect(page.getByRole('link', { name: /Income.*\$4,080\.00/ })).toBeVisible();
  await nav(page, 'Budget');
  await page.getByRole('navigation', { name: 'Whose budget' }).getByRole('link', { name: 'Sam' }).click();
  await expect(page.getByLabel('Name')).toHaveValue('Budget for Sam');
});

/**
 * ADR-0022: a plan on the employer, a payslip that starts from it, and each amount reaching its own account. One account has two possible deposits, so it
 * asks about that one.
 */
test('pay splits across accounts, each deposit in its own account', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `split-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const balance = async (name: string) =>
    (
      (await (await page.request.get(`${ws}/accounts`)).json()).data as {
        name: string;
        balance: { amount: string };
      }[]
    ).find((a) => a.name === name)!.balance.amount;
  const addAccount = async (name: string) => {
    const res = await page.request.post(`${ws}/accounts`, {
      data: {
        name,
        kind: 'savings',
        openingBalance: { amount: '0', currency: 'USD' },
        openingDate: '2026-10-01',
      },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).id as string;
  };
  const college = await addAccount('College fund');
  await addAccount('Vacation');
  const member = (
    await (
      await page.request.post(`${ws}/family-members`, {
        data: { name: 'Sam', relationship: 'spouse_partner' },
      })
    ).json()
  ).id as string;
  const accounts = (await (await page.request.get(`${ws}/accounts`)).json()).data as {
    id: string;
    name: string;
  }[];
  const checking = accounts.find((a) => a.name === 'Joint checking')!.id;
  const made = await page.request.post(`${ws}/employers`, {
    data: { memberId: member, name: 'Acme', depositAccountId: checking },
  });
  expect(made.status()).toBe(201);
  const employerId = (await made.json()).id as string;

  // The plan, on the employer.
  await page.goto(`/w/${workspaceId}/payslips?tab=employers`);
  await page.getByRole('button', { name: 'Split pay from Acme' }).click();
  const plan = page.getByRole('form', { name: 'Split pay from Acme' });
  await expect(plan.getByTestId('deposit-rest')).toContainText('The rest goes to Joint checking');
  await plan.getByRole('button', { name: 'Add an account' }).click();
  await plan.getByLabel('Account for amount 1').selectOption({ label: 'College fund' });
  await plan.getByLabel('Amount 1').fill('200.00');
  await plan.getByRole('button', { name: 'Add an account' }).click();
  await plan.getByLabel('Account for amount 2').selectOption({ label: 'Vacation' });
  await plan.getByLabel('Amount 2').fill('100.00');
  await plan.getByRole('button', { name: 'Save split' }).click();
  await expect(page.getByText('Split saved.')).toBeVisible();
  await expect(page.getByTestId('employer-split-summary')).toContainText('College fund: $200.00');

  // Two deposits could be the College fund's share, so it has to ask about that one.
  const today = new Date().toISOString().slice(0, 10);
  const deposit = async () =>
    (
      await (
        await page.request.post(`${ws}/transactions`, {
          data: {
            date: today,
            accountId: college,
            amount: { amount: '20000', currency: 'USD' },
            payee: 'ACME PAYROLL',
          },
        })
      ).json()
    ).id as string;
  await deposit();
  await deposit();
  const collegeBefore = await balance('College fund');

  const p = await (
    await page.request.post(`${ws}/payslips`, { data: { employerId, payDate: today } })
  ).json();
  const filled = await page.request.patch(`${ws}/payslips/${p.id}`, {
    data: {
      version: p.version,
      net: '150000',
      lines: [
        { section: 'earning', code: 'salary', label: 'Salary', amount: '200000' },
        { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '50000' },
      ],
    },
  });
  expect(filled.status()).toBe(200);

  await page.goto(`/w/${workspaceId}/payslips/${p.id}`);
  const where = page.getByTestId('payslip-deposits');
  await expect(where.getByTestId('deposit-rest')).toContainText('$1,200.00');
  // The rest follows what's typed, for this payslip only.
  await where.getByLabel('Amount 2').fill('1400.00');
  await expect(where.getByRole('alert')).toContainText('has to leave something');
  await where.getByLabel('Amount 2').fill('100.00');
  await expect(where.getByTestId('deposit-rest')).toContainText('$1,200.00');

  await page.getByRole('button', { name: 'Confirm' }).click();
  const choice = page.getByTestId('deposit-choice');
  await expect(choice).toHaveCount(1);
  await expect(choice).toContainText('College fund');
  await choice.getByRole('button', { name: 'Use this one' }).first().click();

  await expect(where.getByTestId('payslip-deposit')).toHaveCount(3);
  await expect(where.getByTestId('payslip-deposit').filter({ hasText: 'Joint checking' })).toContainText(
    '$1,200.00',
  );
  await expect(where.getByTestId('payslip-deposit').filter({ hasText: 'College fund' })).toContainText(
    'Matched',
  );
  await expect(where.getByTestId('payslip-deposit').filter({ hasText: 'Vacation' })).toContainText('$100.00');

  // Joint checking started with $2,500.00. The College fund's deposit was already counted, so it doesn't move.
  expect(await balance('Joint checking')).toBe('370000');
  expect(await balance('Vacation')).toBe('10000');
  expect(await balance('College fund')).toBe(collegeBefore);
});
