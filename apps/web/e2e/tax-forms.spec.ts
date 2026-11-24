import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import pg from 'pg';
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
  // AIA-12, NFR-14: once, at the end of the screen.
  await expect(page.getByTestId('disclaimer-tax')).toHaveCount(1);
  await expect(page.getByTestId('disclaimer-tax')).toContainText('not tax advice');
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
  await expect(page.getByTestId('disclaimer-tax')).toHaveCount(1);
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

  // It's in Review, under the statements and bills, and the Review badge counts it.
  await nav(page, 'Review');
  const badge = page.getByTestId('review-badge');
  await expect(badge).toBeVisible();
  const withForm = Number(await badge.textContent());
  expect(withForm).toBeGreaterThanOrEqual(1);
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
  if (withForm === 1) await expect(page.getByTestId('review-badge')).toHaveCount(0);
  else await expect(page.getByTestId('review-badge')).toHaveText(String(withForm - 1));

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

/**
 * ADR-0052 PR 3: a 1099-INT dropped on the screen is read in the background and matched by itself (TAX-01..03). There's
 * no doc-worker in e2e, so this test plays its part: it takes the `taxform.read` job and hands on what the doc-worker
 * would (masked text and the identifiers). The Node worker then reads it with the fake AI, matches the only account
 * ending 4471 with interest, and the books agreeing confirm it. The same file again is refused.
 */
test('a tax form file is read, matched and confirmed by the books', async ({ page }) => {
  test.setTimeout(150_000);
  await onboardHousehold(page, `taxform-files-${Date.now()}@example.com`, 'Joint checking');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const post = async (path: string, data: object) => {
    const res = await page.request.post(`${ws}${path}`, { data });
    expect(res.status(), `${path}: ${await res.text()}`).toBe(201);
    return res.json();
  };
  const savings = (
    await post('/accounts', {
      name: 'Savings',
      kind: 'savings',
      last4: '4471',
      institution: 'First Example Bank',
      openingDate: '2024-01-01',
    })
  ).id as string;
  const categories = (await (await page.request.get(`${ws}/categories`)).json()).data as {
    id: string;
    name: string;
  }[];
  await post('/transactions', {
    date: '2025-06-30',
    accountId: savings,
    amount: { amount: '41207', currency: 'USD' },
    payee: 'Interest paid',
    categoryId: categories.find((c) => c.name === 'Interest income')!.id,
  });

  await nav(page, 'Tax forms');
  await page.getByRole('navigation', { name: 'Tax year' }).getByRole('link', { name: '2025' }).click();
  await expect(page).toHaveURL(/year=2025/);
  const file = join(mkdtempSync(join(tmpdir(), 'montra-taxform-')), 'first-example-1099.pdf');
  writeFileSync(file, '%PDF-1.4\n% a synthetic 1099-INT\n%%EOF\n');
  await page.getByLabel('Choose files').setInputFiles(file);
  await expect(page.getByTestId('tax-upload-results')).toContainText('first-example-1099.pdf: being read');
  const beingRead = page.getByTestId('tax-being-read');
  await expect(beingRead).toContainText('first-example-1099.pdf');
  await expect(beingRead).toContainText('Reading');

  // The doc-worker's part: its job for this form, completed with the masked text and the identifiers.
  const year = await (await page.request.get(`${ws}/tax-forms?year=2025`)).json();
  const formId = (year.forms as { id: string; status: string }[]).find((f) => f.status === 'reading')!.id;
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra',
  });
  await db.connect();
  try {
    let done = false;
    for (let i = 0; i < 60 && !done; i++) {
      const { rows } = await db.query(`select * from app.dequeue_job('doc', 'e2e-tax-forms')`);
      const job = rows[0];
      if (!job?.id) {
        await page.waitForTimeout(500);
        continue;
      }
      if (job.type === 'taxform.read' && job.payload.formId === formId) {
        await db.query('select app.complete_job($1, $2::jsonb)', [
          job.id,
          JSON.stringify({
            kind: 'taxform_text',
            pageCount: 1,
            textLayer: true,
            ocrEngine: null,
            error: null,
            pages: [
              {
                page: 1,
                text: [
                  'Form 1099-INT Interest Income 2025',
                  "PAYER'S name: First Example Bank",
                  "PAYER'S TIN ••••",
                  "RECIPIENT'S TIN ••••",
                  'Account number (see instructions) ••••',
                  '1 Interest income 412.07',
                ].join('\n'),
                forms: [{ kind: '1099_int', corrected: false, taxYear: 2025 }],
                copiesDropped: 0,
                identifiers: {
                  personTinLast4: '4321',
                  issuerEin: '345678901',
                  issuerTinLast4: null,
                  accountLast4: '4471',
                },
              },
            ],
          }),
        ]);
        done = true;
      } else {
        // Another test's document: no doc-worker runs in e2e, so it's put back for later.
        await db.query('select app.fail_job($1, $2, false)', [job.id, 'e2e: not this test’s job']);
      }
    }
    expect(done).toBe(true);
  } finally {
    await db.end();
  }

  // The screen looks again by itself: the form is read, matched and agrees with the books.
  const expected = page.getByTestId('tax-expected').filter({ hasText: '1099-INT · Savings' });
  await expect(expected).toContainText('Matches the books', { timeout: 45_000 });
  await expect(page.getByTestId('tax-being-read')).toHaveCount(0);
  await expected.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: '1099-INT from First Example Bank' })).toBeVisible();
  const reading = page.getByTestId('tax-reading');
  await expect(reading.getByTestId('tax-reading-stage')).toHaveText(
    'Confirmed: every box checked agrees with the books.',
  );
  await expect(reading.getByTestId('tax-match-reason')).toHaveText(
    'Matched: Savings is the only account ending 4471 with interest in 2025',
  );
  await expect(reading.getByRole('link', { name: 'Open first-example-1099.pdf' })).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);

  // The same file again is refused, with the form made from it.
  await nav(page, 'Tax forms');
  await page.getByRole('navigation', { name: 'Tax year' }).getByRole('link', { name: '2025' }).click();
  await page.getByLabel('Choose files').setInputFiles(file);
  const results = page.getByTestId('tax-upload-results');
  await expect(results).toContainText('first-example-1099.pdf: received already.');
  await results.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/tax-forms/${formId}$`));
});
