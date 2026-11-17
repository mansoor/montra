import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { nav, onboardHousehold } from './phase3-helpers';

/**
 * ADR-0052 PR 2: tax forms typed in and checked against the books (TAX-04..06). The books are seeded through the API:
 * a year of payslips, a savings account's interest and a mortgage's payments. The screen lists the forms the year
 * should bring, a typed W-2 that differs lands in Review, its difference is accepted with a note, and forms that agree
 * with the books show as received and matching.
 */
test('tax forms are expected, typed in, checked against the books and reviewed', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `taxforms-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const post = async (path: string, data: object, status = 201) => {
    const res = await page.request.post(`${ws}${path}`, { data });
    expect(res.status(), `${path}: ${await res.text()}`).toBe(status);
    return res.json();
  };
  const usd = (amount: string) => ({ amount, currency: 'USD' });

  // The books for 2025.
  const everyday = (
    await post('/accounts', {
      name: 'Everyday',
      kind: 'checking',
      openingBalance: usd('5000000'),
      openingDate: '2024-01-01',
    })
  ).id as string;
  const savings = (
    await post('/accounts', { name: 'High-yield savings', kind: 'savings', openingDate: '2024-01-01' })
  ).id as string;
  const categories = (await (await page.request.get(`${ws}/categories`)).json()).data as {
    id: string;
    name: string;
  }[];
  await post('/transactions', {
    date: '2025-06-30',
    accountId: savings,
    amount: usd('4107'),
    payee: 'Interest paid',
    categoryId: categories.find((c) => c.name === 'Interest income')!.id,
  });
  const sam = (await post('/family-members', { name: 'Sam', relationship: 'spouse_partner' })).id as string;
  const acme = (
    await post('/employers', {
      memberId: sam,
      name: 'Acme Corp',
      payFrequency: 'monthly',
      depositAccountId: everyday,
    })
  ).id as string;
  for (const payDate of ['2025-01-31', '2025-02-28']) {
    const p = await post('/payslips', { employerId: acme, payDate });
    const filled = await page.request.patch(`${ws}/payslips/${p.id}`, {
      data: {
        version: p.version,
        net: '400000',
        lines: [
          { section: 'earning', code: 'salary', label: 'Salary', amount: '500000' },
          { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '62000' },
          { section: 'tax', code: 'social_security', label: 'Social Security', amount: '31000' },
          { section: 'tax', code: 'medicare', label: 'Medicare', amount: '7000' },
        ],
      },
    });
    expect(filled.status()).toBe(200);
    await post(`/payslips/${p.id}/confirm`, { version: (await filled.json()).version }, 200);
  }
  const loan = await post('/loans', {
    name: 'Home mortgage',
    newAccount: { kind: 'mortgage' },
    principal: '20000000',
    rateBps: 600,
    termMonths: 360,
    firstPaymentDate: '2025-11-01',
    balanceAsOf: '2025-10-15',
    payingAccountId: everyday,
  });
  for (const [n, date] of [
    [1, '2025-11-01'],
    [2, '2025-12-01'],
  ] as const) {
    await post(`/loans/${loan.id}/payments`, { number: n, accountId: everyday, date });
  }

  // The year's forms: one expected from each.
  await nav(page, 'Tax forms');
  await page.getByRole('navigation', { name: 'Tax year' }).getByRole('link', { name: '2025' }).click();
  await expect(page).toHaveURL(/year=2025/);
  const expected = page.getByTestId('tax-expected');
  await expect(expected).toHaveCount(3);
  await expect(expected.filter({ hasText: 'W-2 · Acme Corp' })).toContainText('Not yet');
  await expect(expected.filter({ hasText: '1099-INT · High-yield savings' })).toContainText('$41.07');
  await expect(expected.filter({ hasText: '1098 · Home mortgage' })).toContainText('Not yet');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);

  // A W-2 typed in, with box 2 misread: $1,340.00 printed as $1,440.00.
  await page.getByRole('button', { name: 'Type a form in' }).click();
  const typed = page.getByRole('form', { name: 'Type a form in' });
  await typed.getByLabel('Form', { exact: true }).selectOption({ label: 'W-2' });
  await typed.getByLabel('Tax year').fill('2025');
  await typed.getByLabel("Employer's name").fill('Acme Corp');
  await typed.getByLabel('EIN').fill('12-3456789');
  await typed.getByLabel('Employer', { exact: true }).selectOption({ label: 'Acme Corp' });
  await typed.getByLabel(/^Box 1: Wages/).fill('10,000.00');
  await typed.getByLabel(/^Box 2: Federal/).fill('1,440.00');
  await typed.getByLabel(/^Box 3: Social Security wages/).fill('10,000.00');
  await typed.getByLabel(/^Box 4:/).fill('620.00');
  await typed.getByLabel(/^Box 5:/).fill('10,000.00');
  await typed.getByLabel(/^Box 6:/).fill('140.00');
  await typed.getByRole('button', { name: 'Add the form' }).click();

  await expect(page).toHaveURL(/\/tax-forms\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'W-2 from Acme Corp' })).toBeVisible();
  await expect(page.getByTestId('tax-form-result').first()).toHaveText('Differs by $200.00');
  const box2 = page
    .getByTestId('tax-check')
    .filter({ has: page.getByRole('rowheader', { name: 'Box 2', exact: true }) });
  await expect(box2).toContainText('Differs');
  await expect(box2).toContainText('$1,240.00');
  await box2.getByText('How this was worked out').click();
  await expect(box2).toContainText('Federal income tax withheld on the year’s payslips');
  await expect(box2.getByRole('link', { name: 'Payslip 1' })).toBeVisible();
  const box1 = page
    .getByTestId('tax-check')
    .filter({ has: page.getByRole('rowheader', { name: 'Box 1', exact: true }) });
  await expect(box1).toContainText('Matches');

  // It's in Review, under the statements and bills.
  await nav(page, 'Review');
  const queue = page.getByTestId('tax-form-queue');
  await expect(queue.getByRole('heading', { name: 'Tax forms to check' })).toBeVisible();
  await expect(queue.getByTestId('tax-form-item')).toContainText('W-2 from Acme Corp · 2025');
  await queue.getByRole('link', { name: 'Open W-2 from Acme Corp' }).click();

  // The difference is accepted with a note; the form leaves Review.
  await page.getByRole('button', { name: 'Accept the difference in box 2' }).click();
  await page.getByLabel('Why it differs').fill('Extra withholding asked for in December');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(
    page.getByText('Difference accepted. It holds while the form and the books stay the same.'),
  ).toBeVisible();
  await expect(page.getByTestId('tax-form-result').first()).toHaveText('Difference accepted');
  await nav(page, 'Review');
  await expect(page.getByTestId('tax-form-queue')).toHaveCount(0);

  // The bank's and the lender's forms agree with the books.
  const schedule = (await (await page.request.get(`${ws}/loans/${loan.id}/schedule`)).json()).data as {
    number: number;
    interest: string;
  }[];
  const interest = schedule.filter((r) => r.number <= 2).reduce((t, r) => t + BigInt(r.interest), 0n);
  await post('/tax-forms', {
    kind: '1099_int',
    taxYear: 2025,
    issuerName: 'First Bank',
    personMemberId: sam,
    targets: [{ accountId: savings }],
    boxes: { box1: '4100' },
  });
  await post('/tax-forms', {
    kind: '1098',
    taxYear: 2025,
    issuerName: 'Home Lender',
    personMemberId: sam,
    targets: [{ accountId: loan.loanAccountId }],
    // Box 3: the loan began in the year, so box 2 is the principal on that day.
    boxes: { box1: String(interest), box2: '20000000', box3: '2025-10-15' },
  });
  await nav(page, 'Tax forms');
  await page.getByRole('navigation', { name: 'Tax year' }).getByRole('link', { name: '2025' }).click();
  await expect(expected.filter({ hasText: '1099-INT' })).toContainText('Matches the books');
  await expect(expected.filter({ hasText: '1098' })).toContainText('Matches the books');
  await expect(expected.filter({ hasText: 'W-2' })).toContainText('Difference accepted');
});
