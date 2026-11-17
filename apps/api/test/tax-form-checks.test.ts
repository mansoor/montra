/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Tax forms checked against the books (ADR-0052 PR 2): a W-2 against payslips, a 1099-INT against interest, a 1099-DIV
// on a valued account recorded from the form, a 1098 against a mortgage's payments; expected forms, Review, accepting a
// difference, matching by hand and what accountants see (TAX-03..TAX-06).
const OWNER = 'checks-owner@example.test';
const MEMBER = 'checks-member@example.test';
const CPA = 'checks-cpa@example.test';

let h: Harness;
let db: pg.Client;
let owner: Client;
let member: Client;
let cpa: Client;
let wsId: string;
let url: (p: string) => string;
let personal: string;
let checking: string;
let savings: string;
let brokerage: string;
let mortgageAccount: string;
let loanId: string;
let sam: string;
let acme: string;
let interestCategory: string;

const usd = (amount: string) => ({ amount, currency: 'USD' });
const join = async (who: Client, body: object) => {
  const invite = await owner.post(url('/sharing/invites'), body);
  expect(invite.status).toBe(201);
  expect((await who.post(`/v1/invites/${invite.body.token}/accept`)).status).toBe(200);
};
const year = async (c: Client, y = 2025) => {
  const res = await c.get(url(`/tax-forms?year=${y}`));
  expect(res.status).toBe(200);
  return res.body;
};
const check = (form: any, box: string) => form.checks.find((c: any) => c.box === box);
const balance = async (id: string) =>
  (await owner.get(url('/accounts'))).body.data.find((a: any) => a.id === id).balance.amount as string;

/** One month's pay at Acme: $5,000.00 salary, $300.00 to the 401(k), and the taxes on it. */
const payslip = async (payDate: string, ytdMonths: number | null = null) => {
  const ytd = (amount: number) => (ytdMonths === null ? {} : { ytd: String(amount * ytdMonths) });
  const p = (await owner.post(url('/payslips'), { employerId: acme, payDate })).body;
  const filled = await owner.patch(url(`/payslips/${p.id}`), {
    version: p.version,
    net: '369750',
    lines: [
      { section: 'earning', code: 'salary', label: 'Salary', amount: '500000', ...ytd(500000) },
      { section: 'pre_tax', code: '401k', label: '401(k)', amount: '30000', ...ytd(30000) },
      { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '62000', ...ytd(62000) },
      { section: 'tax', code: 'social_security', label: 'Social Security', amount: '31000', ...ytd(31000) },
      { section: 'tax', code: 'medicare', label: 'Medicare', amount: '7250', ...ytd(7250) },
    ],
  });
  expect(filled.status).toBe(200);
  const posted = await owner.post(url(`/payslips/${p.id}/confirm`), { version: filled.body.version });
  expect(posted.body.status).toBe('posted');
  return posted.body;
};

/** The W-2 for three months' pay. */
const W2 = {
  kind: 'w2',
  taxYear: 2025,
  issuerName: 'Acme Corp',
  issuerEin: '12-3456789',
  personTinLast4: '6789',
  boxes: {
    box1: '1410000',
    box2: '186000',
    box3: '1500000',
    box4: '93000',
    box5: '1500000',
    box6: '21750',
    box12: [{ code: 'D', amount: '90000' }],
  },
};

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  db = new pg.Client({ connectionString: ADMIN_URL });
  await db.connect();
  owner = h.as(OWNER);
  member = h.as(MEMBER);
  cpa = h.as(CPA);
  wsId = (await owner.post('/v1/workspaces', { name: 'Checks', baseCurrency: 'USD', template: 'household' }))
    .body.id;
  url = (p) => `/v1/workspaces/${wsId}${p}`;
  personal = (await owner.get(url('/entities'))).body.data.find((e: any) => e.type === 'personal').id;
  const account = async (body: object) => {
    const res = await owner.post(url('/accounts'), {
      entityId: personal,
      openingDate: '2024-01-01',
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  checking = await account({ name: 'Checking', kind: 'checking', openingBalance: usd('5000000') });
  savings = await account({ name: 'Savings', kind: 'savings', last4: '4321' });
  brokerage = await account({ name: 'Brokerage', kind: 'investment', planType: 'brokerage' });
  sam = (await owner.post(url('/family-members'), { name: 'Sam', relationship: 'spouse_partner' })).body.id;
  await join(member, { email: MEMBER, role: 'member', familyMember: { id: sam } });
  await join(cpa, { email: CPA, role: 'accountant' });
  const cpaId = (await owner.get(url('/sharing/members'))).body.data.find((m: any) => m.email === CPA).userId;
  await owner.put(url(`/sharing/members/${cpaId}/grants`), {
    grants: [{ entityId: personal, access: 'write' }],
  });
  acme = (
    await owner.post(url('/employers'), {
      memberId: sam,
      name: 'Acme Corp',
      payFrequency: 'monthly',
      depositAccountId: checking,
    })
  ).body.id;
  interestCategory = (await owner.get(url('/categories'))).body.data.find(
    (c: any) => c.name === 'Interest income',
  ).id;

  // A $200,000.00 mortgage at 6%, paid monthly through 2025.
  const loan = await owner.post(url('/loans'), {
    name: 'Home mortgage',
    newAccount: { kind: 'mortgage' },
    principal: '20000000',
    rateBps: 600,
    termMonths: 360,
    firstPaymentDate: '2025-01-01',
    balanceAsOf: '2024-12-15',
    payingAccountId: checking,
  });
  expect(loan.status).toBe(201);
  loanId = loan.body.id;
  mortgageAccount = loan.body.loanAccountId;
  for (let n = 1; n <= 12; n++) {
    const paid = await owner.post(url(`/loans/${loanId}/payments`), {
      number: n,
      accountId: checking,
      date: `2025-${String(n).padStart(2, '0')}-01`,
    });
    expect(paid.status).toBe(201);
  }
});
afterAll(async () => {
  await db.end();
  await h.close();
});

describe('a W-2 against the payslips (TAX-04, §5.2)', () => {
  let w2: any;

  it('finds a payslip missing from the year-to-date figures, and lists the form in Review', async () => {
    await payslip('2025-01-31');
    await payslip('2025-03-31', 3);
    const res = await owner.post(url('/tax-forms'), { ...W2, targets: [{ employerId: acme }] });
    expect(res.status).toBe(201);
    w2 = res.body;
    expect(w2.result).toMatchObject({ state: 'differs', difference: '500000', review: true });
    expect(check(w2, '1')).toMatchObject({
      form: '1410000',
      books: '940000',
      difference: '470000',
      status: 'differs',
    });
    expect(check(w2, '1').explanation).toMatch(
      /a payslip seems to be missing \(no pay between 31 January 2025 and 31 March 2025\)/,
    );
    expect(check(w2, '1').sources.payslipIds).toHaveLength(2);
    expect(check(w2, '12D')).toMatchObject({ books: '60000', status: 'differs' });
    expect((await owner.get(url('/tax-forms/review'))).body.data.map((f: any) => f.id)).toContain(w2.id);
  });

  it('matches once the missing payslip is added, with nothing stored in between', async () => {
    await payslip('2025-02-28');
    const now = (await owner.get(url(`/tax-forms/${w2.id}`))).body;
    expect(now.result).toMatchObject({ state: 'matches', review: false });
    expect(now.checks.filter((c: any) => c.kind === 'check').map((c: any) => [c.box, c.status])).toEqual([
      ['1', 'matches'],
      ['2', 'matches'],
      ['3', 'matches'],
      ['4', 'matches'],
      ['5', 'matches'],
      ['6', 'matches'],
      ['12D', 'matches'],
    ]);
    expect((await owner.get(url('/tax-forms/review'))).body.data.map((f: any) => f.id)).not.toContain(w2.id);
  });

  it('accepts a difference with a note while it stays the same', async () => {
    const edited = await owner.patch(url(`/tax-forms/${w2.id}`), {
      boxes: { ...W2.boxes, box2: '196000' },
      version: (await owner.get(url(`/tax-forms/${w2.id}`))).body.version,
    });
    expect(edited.body.result.state).toBe('differs');
    expect((await owner.post(url(`/tax-forms/${w2.id}/accept`), { box: '1', note: 'No' })).body.code).toBe(
      'tax_form.nothing_to_accept',
    );
    const accepted = await owner.post(url(`/tax-forms/${w2.id}/accept`), {
      box: '2',
      note: 'Extra withholding on a bonus paid as a gift card',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.result).toMatchObject({ state: 'accepted', review: false });
    expect(check(accepted.body, '2')).toMatchObject({
      status: 'accepted',
      acceptedNote: 'Extra withholding on a bonus paid as a gift card',
    });
    // The form changes again: the acceptance no longer holds.
    const again = await owner.patch(url(`/tax-forms/${w2.id}`), {
      boxes: { ...W2.boxes, box2: '206000' },
      version: accepted.body.version,
    });
    expect(again.body.result.state).toBe('differs');
    await owner.patch(url(`/tax-forms/${w2.id}`), { boxes: W2.boxes, version: again.body.version });
  });

  it('learned the issuer and the person from the match by hand (TAX-03)', async () => {
    const { rows } = await db.query(
      `select kind, signal, target_id, confirmations from app.match_memory where workspace_id = $1 order by kind`,
      [wsId],
    );
    expect(rows).toEqual([
      { kind: 'tax_issuer', signal: 'w2:ein:123456789', target_id: acme, confirmations: 1 },
      {
        kind: 'tax_person',
        signal: expect.stringMatching(/^tin4:[A-Za-z0-9_-]{32}$/),
        target_id: sam,
        confirmations: 1,
      },
    ]);
    // The last four digits are never in the memory, which every member can read.
    expect(rows[1].signal).not.toContain('6789');
  });

  it('gives an accountant the totals, not the payslips, and doesn’t let them match a W-2 to an employer', async () => {
    await owner.put(url('/accountant-tax-forms'), { accountantSeesTaxForms: true });
    const seen = (await cpa.get(url(`/tax-forms/${w2.id}`))).body;
    expect(seen.result.state).toBe('matches');
    expect(check(seen, '1')).toMatchObject({ books: '1410000', status: 'matches' });
    expect(check(seen, '1').sources.payslipIds).toEqual([]);
    expect((await cpa.get(url('/payslips'))).body.data ?? []).toEqual([]);
    const typed = await cpa.post(url('/tax-forms'), {
      ...W2,
      personMemberId: sam,
      targets: [{ employerId: acme }],
    });
    expect(typed.status).toBe(403);
    // Typed unmatched, it waits for an owner, an admin or Sam.
    const unmatched = await cpa.post(url('/tax-forms'), { ...W2, personMemberId: sam, corrected: true });
    expect(unmatched.status).toBe(201);
    expect(unmatched.body.result).toMatchObject({ state: 'needs_match', review: true });
    const match = await cpa.patch(url(`/tax-forms/${unmatched.body.id}`), {
      targets: [{ employerId: acme }],
      version: unmatched.body.version,
    });
    expect(match.status).toBe(403);
    // Sam matches it.
    const mine = await member.patch(url(`/tax-forms/${unmatched.body.id}`), {
      targets: [{ employerId: acme }],
      version: unmatched.body.version,
    });
    expect(mine.status).toBe(200);
    expect(mine.body.result.state).toBe('matches');
    await owner.delete(url(`/tax-forms/${unmatched.body.id}`));
    await owner.put(url('/accountant-tax-forms'), { accountantSeesTaxForms: false });
  });
});

describe('a 1099-INT against the interest (§5.3, §5.7)', () => {
  it('explains December’s interest posted on 2 January by the year boundary', async () => {
    for (const [date, amount] of [
      ['2025-06-30', '2000'],
      ['2026-01-02', '4107'],
    ]) {
      const t = await owner.post(url('/transactions'), {
        date,
        accountId: savings,
        amount: usd(amount!),
        payee: 'First Bank interest',
        categoryId: interestCategory,
      });
      expect(t.status).toBe(201);
    }
    const res = await owner.post(url('/tax-forms'), {
      kind: '1099_int',
      taxYear: 2025,
      issuerName: 'First Bank',
      issuerEin: '98-7654321',
      accountLast4: '4321',
      personMemberId: sam,
      targets: [{ accountId: savings }],
      boxes: { box1: '6107' },
    });
    expect(res.status).toBe(201);
    expect(check(res.body, '1+3+8')).toMatchObject({ form: '6107', books: '2000', status: 'explained' });
    expect(check(res.body, '1+3+8').explanation).toMatch(/\$41\.07 of interest posted on 2 January 2026/);
    expect(check(res.body, '1+3+8').sources.transactionIds).toHaveLength(1);
    expect(res.body.result.state).toBe('matches');
  });

  it('finds interest by Schedule B’s tax line, whatever the category is called', async () => {
    const before = (await owner.get(url(`/accounts/${savings}/interest-earned`))).body;
    await owner.patch(url(`/categories/${interestCategory}`), { name: 'Savings yield' });
    const after = (await owner.get(url(`/accounts/${savings}/interest-earned`))).body;
    expect(after.amount).toBe(before.amount);
    expect(after.amount).toBe('4107');
    const form = (await year(owner)).forms.find((f: any) => f.kind === '1099_int');
    expect(check(form, '1+3+8').books).toBe('2000');
  });
});

describe('a 1099-DIV on a valued account: Record from the form (§5.6)', () => {
  let div: any;

  it('is not tracked, and offers to record the dividends', async () => {
    div = (
      await owner.post(url('/tax-forms'), {
        kind: '1099_div',
        taxYear: 2025,
        issuerName: 'Big Brokerage',
        personMemberId: sam,
        targets: [{ accountId: brokerage }],
        boxes: { box1a: '125000', box1b: '100000' },
      })
    ).body;
    expect(div.result).toMatchObject({
      state: 'not_tracked',
      review: false,
      recordable: {
        amount: '125000',
        accountId: brokerage,
        accountName: 'Brokerage',
        categoryName: 'Dividends',
      },
    });
  });

  it('moves the amount from investment gains to Dividends without changing the balance, and takes it back', async () => {
    const before = await balance(brokerage);
    expect((await owner.post(url(`/tax-forms/${div.id}/record`), { amount: '124999' })).body.code).toBe(
      'tax_form.amount_changed',
    );
    const recorded = await owner.post(url(`/tax-forms/${div.id}/record`), { amount: '125000' });
    expect(recorded.status).toBe(200);
    expect(recorded.body.result).toMatchObject({
      state: 'matches',
      recordable: null,
      recorded: { amount: '125000', date: '2025-12-31' },
    });
    expect(check(recorded.body, '1a').sources.journalEntryIds).toHaveLength(1);
    expect(await balance(brokerage)).toBe(before);
    expect((await owner.post(url(`/tax-forms/${div.id}/record`), { amount: '125000' })).body.code).toBe(
      'tax_form.recorded',
    );
    // Now expected too: the brokerage has dividends in the year.
    expect((await year(owner)).expected).toContainEqual(
      expect.objectContaining({ kind: '1099_div', accountId: brokerage, state: 'received', formId: div.id }),
    );
    const undone = await owner.delete(url(`/tax-forms/${div.id}/record`));
    expect(undone.body.result).toMatchObject({ state: 'not_tracked', recorded: null });
    expect(await balance(brokerage)).toBe(before);
  });
});

describe('a 1098 against the mortgage (§5.5)', () => {
  it('checks the year’s interest and the principal on 1 January', async () => {
    const schedule = (await owner.get(url(`/loans/${loanId}/schedule`))).body.data;
    const interest = schedule
      .filter((r: any) => r.number <= 12)
      .reduce((t: bigint, r: any) => t + BigInt(r.interest), 0n);
    const res = await owner.post(url('/tax-forms'), {
      kind: '1098',
      taxYear: 2025,
      issuerName: 'Home Lender',
      personMemberId: sam,
      targets: [{ accountId: mortgageAccount }],
      boxes: { box1: String(interest), box2: '20000000', box10: '480000' },
    });
    expect(res.status).toBe(201);
    expect(check(res.body, '1')).toMatchObject({ books: String(interest), status: 'matches' });
    expect(check(res.body, '1').sources.loanPaymentIds).toHaveLength(12);
    expect(check(res.body, '2')).toMatchObject({ books: '20000000', status: 'matches' });
    expect(check(res.body, '10')).toMatchObject({ kind: 'info' });
    expect(res.body.result.state).toBe('matches');
  });
});

describe('expected forms and Review (TAX-05, TAX-06, §7.1)', () => {
  it('lists the forms the year should bring against those received', async () => {
    const y = await year(owner);
    const byKind = (kind: string) => y.expected.filter((e: any) => e.kind === kind);
    expect(byKind('w2')).toEqual([
      expect.objectContaining({
        employerId: acme,
        personMemberId: sam,
        state: 'received',
        amount: '1500000',
      }),
    ]);
    expect(byKind('1099_int')).toEqual([expect.objectContaining({ accountId: savings, state: 'received' })]);
    expect(byKind('1098')).toEqual([
      expect.objectContaining({ accountId: mortgageAccount, state: 'received' }),
    ]);
    expect(y.unexpectedFormIds).toContain(y.forms.find((f: any) => f.kind === '1099_div').id);
  });

  it('shows a waived form as won’t come, and a missing one as not yet', async () => {
    const w2 = (await year(owner)).forms.find((f: any) => f.kind === 'w2');
    await owner.delete(url(`/tax-forms/${w2.id}`));
    expect((await year(owner)).expected.find((e: any) => e.kind === 'w2').state).toBe('missing');
    const waiver = await owner.post(url('/tax-forms/waivers'), {
      taxYear: 2025,
      kind: 'w2',
      employerId: acme,
      reason: 'combined',
    });
    expect((await year(owner)).expected.find((e: any) => e.kind === 'w2')).toMatchObject({
      state: 'waived',
      waiverId: waiver.body.id,
    });
    await owner.post(url(`/trash/tax_form/${w2.id}/restore`));
  });

  it('lists only what each reader can see', async () => {
    // An accountant with the setting off sees no forms, and no W-2 expected from payslips they can't read.
    const y = await year(cpa);
    expect(y.forms).toEqual([]);
    expect(y.expected.some((e: any) => e.kind === 'w2')).toBe(false);
    expect((await cpa.get(url('/tax-forms/review'))).body.data).toEqual([]);
    // Sam sees the W-2 expected from his own payslips.
    expect((await year(member)).expected.some((e: any) => e.kind === 'w2' && e.employerId === acme)).toBe(
      true,
    );
  });

  it('puts unmatched forms in Review with their reason', async () => {
    const res = await member.post(url('/tax-forms'), {
      kind: '1099_int',
      taxYear: 2024,
      issuerName: 'Credit Union',
      personMemberId: sam,
      boxes: { box1: '1500' },
    });
    expect(res.body.result).toMatchObject({ state: 'needs_match', review: true });
    const review = (await member.get(url('/tax-forms/review'))).body.data;
    expect(review.map((f: any) => [f.taxYear, f.result.state])).toContainEqual([2024, 'needs_match']);
  });
});
