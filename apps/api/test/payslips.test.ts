/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFakeReceiptImage } from '@montra/ai-gateway';
import { addDays, startOfMonth, todayIn } from '@montra/domain';
import { ImportJobs } from '../src/imports/import-jobs.js';
import { Worker } from '../src/jobs/queue.js';
import { PayslipJobs } from '../src/payslips/payslip-jobs.js';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Payslips end to end (PAY-01..09, FAM-08/09), with the worked example from design 04 §14.
const today = todayIn('UTC');
const payDate = startOfMonth(today);
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'payslips@example.com';

const LINES = [
  { section: 'earning', code: 'salary', label: 'Salary', amount: '500000', ytd: '5000000' },
  { section: 'pre_tax', code: '401k', label: '401(k)', amount: '30000' },
  { section: 'pre_tax', code: 'health', label: 'Health insurance', amount: '7500' },
  { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '62000' },
  { section: 'tax', code: 'state_tax', label: 'State income tax', amount: '21000' },
  { section: 'tax', code: 'social_security', label: 'Social Security', amount: '31000' },
  { section: 'tax', code: 'medicare', label: 'Medicare', amount: '7250' },
  { section: 'employer', code: 'match', label: 'Employer match', amount: '15000' },
];
const NET = '341250';

let h: Harness;
let c: Client;
let partner: Client;
let worker: Worker;
let admin: pg.Client;
let url: (p: string) => string;
let cat: (name: string) => string;
let checking: string;
let sam: string;
let employer: any;

async function upload(bytes: Uint8Array, path = '/payslips/files', name = 'slip.png') {
  const boundary = '----montra' + Math.random().toString(16).slice(2);
  const res = await h.app.inject({
    method: 'POST',
    url: url(path),
    headers: {
      authorization: `Bearer dev:${EMAIL}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const draft = async (date = payDate, lines: object[] = LINES, net = NET) => {
  const p = (await c.post(url('/payslips'), { employerId: employer.id, payDate: date })).body;
  const res = await c.patch(url(`/payslips/${p.id}`), { lines, net, version: p.version });
  expect(res.status).toBe(200);
  return res.body;
};
const balance = async (who: Client, id: string) =>
  (await who.get(url('/accounts'))).body.data.find((a: any) => a.id === id).balance.amount as string;

beforeAll(async () => {
  h = await startHarness({ AI_PROVIDER: 'fake' });
  h.app.get(PayslipJobs).register();
  h.app.get(ImportJobs).register();
  worker = h.app.get(Worker);
  c = h.as(EMAIL);
  partner = h.as('payslip-partner@example.com');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Payslips', baseCurrency: 'USD', template: 'household' })
  ).body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Joint checking',
      kind: 'checking',
      openingBalance: usd('100000'),
      openingDate: addDays(payDate, -40),
    })
  ).body.id;
  const cats = (await c.get(url('/categories'))).body.data;
  cat = (name) => cats.find((x: any) => x.name === name).id;
  sam = (await c.post(url('/family-members'), { name: 'Sam', relationship: 'spouse_partner' })).body.id;
  const invite = await c.post(url('/sharing/invites'), {
    email: 'payslip-partner@example.com',
    role: 'partner',
  });
  expect(invite.status).toBe(201);
  expect((await partner.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('employers (PAY-01)', () => {
  it('adds an income source for a member, with the account the pay lands in', async () => {
    const res = await c.post(url('/employers'), {
      memberId: sam,
      name: 'ACME Corp',
      payFrequency: 'monthly',
      depositAccountId: checking,
      payee: 'ACME PAYROLL',
    });
    expect(res.status).toBe(201);
    employer = res.body;
    expect(employer).toMatchObject({ memberId: sam, type: 'employer', payFrequency: 'monthly' });
    const bad = await c.post(url('/employers'), {
      memberId: sam,
      name: 'X',
      depositAccountId: cat('Salary'),
    });
    expect(bad.status).toBe(422);
  });
});

describe('capture (PAY-03, PAY-09)', () => {
  const SLIP = [
    'Employer: ACME Corp',
    'Employee: Sam  SSN 123-45-6789',
    `Pay date: ${payDate}`,
    'Regular salary   5,000.00 ytd 50,000.00',
    '401(k)   300.00',
    'Federal tax   620.00',
    'Net pay   4,080.00',
  ].join('\n');

  it('by default OCRs in our own infrastructure and sends no image', async () => {
    const f = await upload(encodeFakeReceiptImage(SLIP));
    expect(f.status).toBe(201);
    const p = (await c.post(url('/payslips'), { employerId: employer.id, fileIds: [f.body.fileId] })).body;
    expect(p.status).toBe('processing');
    const { rows } = await admin.query(
      `select queue, type, then_job, workspace_id, created_by from app.job
        where type = 'receipt.ocr' and then_job->'payload'->>'payslipId' = $1`,
      [p.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queue: 'doc', type: 'receipt.ocr' });
    expect(rows[0].then_job).toMatchObject({ queue: 'ai', type: 'payslip.extract' });
    // No doc-worker in this test: it would otherwise sit in the shared queue.
    await admin.query(
      `update app.job set status = 'cancelled' where type = 'receipt.ocr' and status = 'queued'`,
    );

    // What the doc-worker hands on: the extraction reads this text, as there's no image to read.
    await h.app.get(PayslipJobs).extract({
      workspace_id: rows[0].workspace_id,
      created_by: rows[0].created_by,
      payload: { ...rows[0].then_job.payload, previousResult: { kind: 'receipt_text', pages: [SLIP] } },
    } as any);
    expect((await c.get(url(`/payslips/${p.id}`))).body).toMatchObject({
      status: 'needs_review',
      gross: '500000',
      net: '408000',
      transactionId: null,
    });
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('reads a draft with "Allow documents" on, and always waits for confirmation', async () => {
    await c.patch(url('/ai/settings'), { allowDocumentsToLlm: true });
    const f = await upload(encodeFakeReceiptImage(SLIP));
    const created = (await c.post(url('/payslips'), { employerId: employer.id, fileIds: [f.body.fileId] }))
      .body;
    await worker.drain(['ai']);
    await c.patch(url('/ai/settings'), { allowDocumentsToLlm: false });
    const p = (await c.get(url(`/payslips/${created.id}`))).body;
    expect(p).toMatchObject({ status: 'needs_review', payDate, net: '408000', gross: '500000', gap: '0' });
    expect(p.lines.map((l: any) => [l.section, l.code, l.amount])).toEqual([
      ['earning', 'salary', '500000'],
      ['pre_tax', '401k', '30000'],
      ['tax', 'fed_tax', '62000'],
    ]);
    expect(p.transactionId).toBeNull();
    const file = await h.app.inject({
      method: 'GET',
      url: url(`/payslips/${p.id}/files/${p.fileIds[0]}`),
      headers: { authorization: `Bearer dev:${EMAIL}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['cache-control']).toContain('no-store');
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('rejects a file that is not a document', async () => {
    expect((await upload(new TextEncoder().encode('not a payslip'))).status).toBe(415);
  });
});

describe('posting and deposit matching (PAY-04, PAY-05)', () => {
  let slip: any;
  let deposit: any;

  it('refuses a payslip that does not add up', async () => {
    const p = await draft(payDate, LINES, '341000');
    expect(p.gap).toBe('250');
    const res = await c.post(url(`/payslips/${p.id}/confirm`), { version: p.version });
    expect(res.status).toBe(422);
    expect((await c.get(url(`/payslips/${p.id}`))).body.status).toBe('needs_review');
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('takes over the imported deposit, so it is not counted twice', async () => {
    deposit = (
      await c.post(url('/transactions'), {
        date: addDays(payDate, 1),
        accountId: checking,
        amount: usd(NET),
        payee: 'ACME PAYROLL',
        categoryId: cat('Salary'),
      })
    ).body;
    const before = await balance(c, checking);
    expect(before).toBe(String(100000n + 341250n));
    const p = await draft();
    const res = await c.post(url(`/payslips/${p.id}/confirm`), { version: p.version });
    expect(res.status).toBe(200);
    slip = res.body;
    expect(slip).toMatchObject({ status: 'posted', transactionId: deposit.id, matchedDeposit: true });
    expect(await balance(c, checking)).toBe(before);
    // The statement's date stays, even though the pay date is a day earlier.
    const t = (await c.get(url(`/transactions/${deposit.id}`))).body;
    expect(t.date).toBe(addDays(payDate, 1));
    expect(t.amount).toEqual(usd(NET));
  });

  it('posts one balanced entry, tagged to the member', async () => {
    const { rows } = await admin.query(
      `select a.name, p.amount_minor::text as amount, p.member_id, p.restricted, p.public_line
         from app.posting p join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
         join app.ledger_account a on a.id = p.ledger_account_id
        where je.transaction_id = $1 order by p.line_no`,
      [deposit.id],
    );
    expect(rows.map((r) => [r.name, r.amount])).toEqual([
      ['Joint checking', '341250'],
      ['Salary', '-500000'],
      ['ACME Corp retirement', '30000'],
      ['Health insurance', '7500'],
      ['Federal income tax', '62000'],
      ['State income tax', '21000'],
      ['Social Security', '31000'],
      ['Medicare', '7250'],
    ]);
    expect(rows.every((r) => r.member_id === sam)).toBe(true);
    // Only the deposit is public; the employer match stayed on the payslip.
    expect(rows.filter((r) => !r.restricted).map((r) => r.name)).toEqual(['Joint checking']);
  });

  it('creates the retirement account, which counts in net worth', async () => {
    const accounts = (await c.get(url('/accounts'))).body.data;
    expect(accounts.find((a: any) => a.name === 'ACME Corp retirement')).toMatchObject({
      kind: 'investment',
      balance: usd('30000'),
    });
    const n = (await c.get(url('/net-worth?months=1'))).body;
    expect(n.assets).toBe(String(100000n + 341250n + 30000n));
  });

  it('can only be changed through the payslip', async () => {
    const edit = await c.patch(
      url(`/transactions/${deposit.id}`),
      { categoryId: cat('Other income') },
      { 'if-match': `"v${(await c.get(url(`/transactions/${deposit.id}`))).body.version}"` },
    );
    expect(edit.status).toBe(422);
    expect(edit.body.code).toBe('payslip.managed');
    const del = await c.delete(url(`/transactions/${deposit.id}`));
    expect(del.status).toBe(422);
    // Notes aren't the ledger, so they stay editable, and the entry survives them.
    const note = await c.patch(url(`/transactions/${deposit.id}`), { memo: 'March pay' });
    expect(note.status).toBe(200);
    const { rows } = await admin.query(
      `select count(*)::int as n from app.posting p join app.journal_entry je
          on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id where je.transaction_id = $1`,
      [deposit.id],
    );
    expect(rows[0].n).toBe(8);
  });

  it('keeps a deposit when the import it came from is undone', async () => {
    const date = addDays(payDate, -20);
    const before = await balance(c, checking);
    const csv = new TextEncoder().encode(`Date,Description,Amount\n${date},ACME BONUS RUN,777.00\n`);
    const up = await upload(csv, '/uploads', 'bank.csv');
    expect(up.status).toBe(201);
    const batch = (await c.post(url('/imports'), { fileId: up.body.fileId, accountId: checking })).body;
    await worker.drain();
    await c.post(url(`/imports/${batch.id}/commit`));
    await worker.drain();
    const lines = [
      { section: 'earning', code: 'bonus', label: 'Bonus', amount: '90000' },
      { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '12300' },
    ];
    const p = await draft(date, lines, '77700');
    const posted = (await c.post(url(`/payslips/${p.id}/confirm`), { version: p.version })).body;
    expect(posted).toMatchObject({ status: 'posted', matchedDeposit: true });

    await c.post(url(`/imports/${batch.id}/undo`));
    await worker.drain();
    const { jobId } = (await c.get(url(`/imports/${batch.id}`))).body;
    expect((await c.get(url(`/jobs/${jobId}`))).body.result.kept).toEqual([
      { transactionId: posted.transactionId, reason: 'payslip' },
    ]);
    expect(await balance(c, checking)).toBe(String(BigInt(before) + 77700n));
    expect((await c.get(url(`/payslips/${p.id}`))).body.status).toBe('posted');

    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
    expect((await c.delete(url(`/transactions/${posted.transactionId}`))).status).toBe(200);
    expect(await balance(c, checking)).toBe(before);
  });

  it('asks when several deposits could be this pay', async () => {
    const make = (d: string) =>
      c.post(url('/transactions'), {
        date: d,
        accountId: checking,
        amount: usd('100000'),
        payee: 'Mystery',
        categoryId: cat('Other income'),
      });
    const date = addDays(payDate, 10);
    const one = (await make(date)).body;
    const two = (await make(addDays(date, 1))).body;
    const lines = [
      { section: 'earning', code: 'bonus', label: 'Bonus', amount: '120000' },
      { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '20000' },
    ];
    const p = await draft(date, lines, '100000');
    const asked = (await c.post(url(`/payslips/${p.id}/confirm`), { version: p.version })).body;
    expect(asked.status).toBe('needs_review');
    expect(asked.matchCandidates.map((x: any) => x.transactionId)).toEqual([one.id, two.id]);
    const chosen = (
      await c.post(url(`/payslips/${p.id}/confirm`), { version: asked.version, depositTransactionId: two.id })
    ).body;
    expect(chosen).toMatchObject({ status: 'posted', transactionId: two.id, matchCandidates: [] });
    // Removing the payslip gives the plain deposit back.
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
    const back = (await c.get(url(`/transactions/${two.id}`))).body;
    expect(back.amount).toEqual(usd('100000'));
    // It keeps the statement's date, not the payslip's pay date.
    const dates = await admin.query(
      `select distinct je.entry_date::text as d from app.journal_entry je where je.transaction_id = $1`,
      [two.id],
    );
    expect(dates.rows).toEqual([{ d: addDays(date, 1) }]);
    expect(back.splits).toEqual([
      expect.objectContaining({ accountId: cat('Other income'), amount: '100000' }),
    ]);
    await c.delete(url(`/transactions/${one.id}`));
    await c.delete(url(`/transactions/${two.id}`));
  });

  it('posts a new transaction when there is no deposit, and deleting removes it', async () => {
    const before = await balance(c, checking);
    const lines = [
      { section: 'earning', code: 'bonus', label: 'Bonus', amount: '50000' },
      { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '10000' },
    ];
    const p = await draft(addDays(payDate, 20), lines, '40000');
    const res = (await c.post(url(`/payslips/${p.id}/confirm`), { version: p.version })).body;
    expect(res).toMatchObject({ status: 'posted', matchedDeposit: false });
    expect(await balance(c, checking)).toBe(String(BigInt(before) + 40000n));
    const t = (await c.get(url(`/transactions/${res.transactionId}`))).body;
    expect(t).toMatchObject({ source: 'payslip', amount: usd('40000'), payee: 'ACME Corp' });
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
    expect(await balance(c, checking)).toBe(before);
  });

  it('fills a new payslip from the last one (PAY-03)', async () => {
    const p = (await c.post(url('/payslips'), { employerId: employer.id, fromLast: true })).body;
    expect(p).toMatchObject({ status: 'needs_review', net: NET, gross: '500000', gap: '0' });
    expect(p.lines).toHaveLength(LINES.length);
    expect(p.lines[0].ytd).toBeNull();
    expect(p.extraction.warnings[0]).toContain('last payslip');
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('edits re-post, and the deposit still counts once', async () => {
    const lines = LINES.map((l) =>
      l.code === 'fed_tax' ? { ...l, amount: '60000' } : l.code === 'salary' ? { ...l, amount: '498000' } : l,
    );
    const res = await c.patch(url(`/payslips/${slip.id}`), { lines, version: slip.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'posted', gross: '498000', gap: '0' });
    expect(await balance(c, checking)).toBe(String(100000n + 341250n));
    const back = await c.patch(url(`/payslips/${slip.id}`), { lines: LINES, version: res.body.version });
    expect(back.status).toBe(200);
    slip = back.body;
  });
});

describe('privacy (PAY-09, ADR-0016)', () => {
  it('hides the payslip from a partner, but keeps the shared account right', async () => {
    const list = await partner.get(url('/payslips'));
    expect(list.body.data).toEqual([]);
    const slip = (await c.get(url('/payslips?status=posted'))).body.data[0];
    expect((await partner.get(url(`/payslips/${slip.id}`))).status).toBe(404);
    expect((await partner.get(url('/employers'))).body.data).toEqual([]);
    // The same balance as the owner: the deposit is a bank fact.
    expect(await balance(partner, checking)).toBe(await balance(c, checking));
    const reg = (await partner.get(url(`/accounts/${checking}/register`))).body;
    expect(reg.data.map((l: any) => l.debit)).toContain(NET);
    // The transaction shows net pay and nothing more.
    const t = (await partner.get(url(`/transactions/${slip.transactionId}`))).body;
    expect(t.amount).toEqual(usd(NET));
    const posted = t.entries.flatMap((e: any) => e.postings);
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(t)).not.toContain('500000');
    expect(JSON.stringify(t)).not.toContain('Federal');
  });

  it('keeps gross pay and taxes out of every total a partner can see', async () => {
    const report = (await partner.get(url('/reports/by-member'))).body;
    const samRow = report.members.find((m: any) => m.memberId === sam);
    expect(samRow?.income ?? '0').toBe('0');
    expect(JSON.stringify(report)).not.toContain('Federal');
    const summary = await partner.get(url(`/reports/payslip-summary?memberId=${sam}`));
    expect(summary.status).toBe(403);
    const sankey = (await partner.get(url('/flow/sankey'))).body;
    expect(JSON.stringify(sankey)).not.toContain('500000');
  });

  it("keeps it out of a partner's sync feed, which a phone stores offline", async () => {
    const boot = (await partner.get(url('/sync/pull?since=0'))).body;
    const slip = (await c.get(url('/payslips?status=posted'))).body.data[0];
    const pay = boot.transactions.find((t: any) => t.id === slip.transactionId);
    expect(pay.amount).toEqual(usd(NET));
    const text = JSON.stringify(boot.transactions);
    for (const secret of ['500000', '62000', '30000', 'Federal income tax', '401(k)']) {
      expect(text).not.toContain(secret);
    }
    // Its balance is what the partner may see: restricted lines don't count.
    expect(boot.accounts.find((x: any) => x.name === 'ACME Corp retirement').balance.amount).toBe('0');
    expect(JSON.stringify(boot)).not.toContain('"payslipId"');
  });

  it('shows a member their own payslips once linked to their login', async () => {
    const me = (await partner.get('/v1/me')).body;
    const member = (await c.get(url('/family-members'))).body.data.find((m: any) => m.id === sam);
    const link = await c.patch(url(`/family-members/${sam}`), {
      linkedUserId: me.id,
      version: member.version,
    });
    expect(link.status).toBe(200);
    expect((await partner.get(url('/payslips'))).body.data).toHaveLength(1);
    expect((await partner.get(url(`/reports/payslip-summary?memberId=${sam}`))).status).toBe(200);
    const undo = (await c.get(url('/family-members'))).body.data.find((m: any) => m.id === sam);
    await c.patch(url(`/family-members/${sam}`), { linkedUserId: null, version: undo.version });
  });
});

describe('budgets and reports (PAY-06, PAY-07, FAM-08, FAM-09)', () => {
  it('plans on take-home pay, and taxes are not spending', async () => {
    const d = (await c.get(url('/dashboard'))).body;
    expect(d.income.amount).toBe(NET);
    expect(d.spent.amount).toBe('0');
    const budget = (await c.post(url('/budgets'), { entityId: d.entityId, name: 'Household' })).body;
    const p = (await c.get(url(`/budgets/${budget.id}/periods/current`))).body;
    expect(p.income.actual).toBe(NET);
    expect(p.activity).toBe('0');
    expect(p.groups.some((g: any) => g.name === 'Payroll taxes and deductions')).toBe(false);
  });

  it('expects income from the pattern of payslips (PAY-07)', async () => {
    const rows = (await c.get(url('/expected-income'))).body.data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'ACME Corp',
      amount: NET,
      cadence: 'monthly',
      memberId: sam,
      accountId: checking,
      nextDate: payDate,
    });
    const budget = (await c.get(url('/budgets'))).body.data[0];
    const p = (await c.get(url(`/budgets/${budget.id}/periods/current`))).body;
    expect(p.income.items[0]).toMatchObject({ expected: NET, actual: NET });
  });

  it('reports income and spending by member, with Household as its own group (FAM-08)', async () => {
    await c.post(url('/transactions'), {
      date: addDays(payDate, 2),
      accountId: checking,
      amount: usd('-4000'),
      payee: 'Bookstore',
      categoryId: cat('Education'),
      memberId: sam,
    });
    await c.post(url('/transactions'), {
      date: addDays(payDate, 2),
      accountId: checking,
      amount: usd('-6000'),
      payee: 'Grocer',
      categoryId: cat('Groceries'),
    });
    const r = (await c.get(url('/reports/by-member'))).body;
    expect(r.members.map((m: any) => m.name)).toEqual(['Household', 'Sam']);
    const [household, member] = r.members;
    expect(household).toMatchObject({ memberId: null, spending: '6000', spendingShare: 60 });
    // Gross income by earner; payroll taxes aren't anyone's spending.
    expect(member).toMatchObject({ memberId: sam, income: '500000', spending: '4000', spendingShare: 40 });
    expect(member.categories).toEqual([expect.objectContaining({ name: 'Education', amount: '4000' })]);
  });

  it('drills down to a member, and to Household (FAM-09)', async () => {
    const names = async (memberId: string) =>
      (await c.get(url(`/transactions?memberId=${memberId}&limit=50`))).body.data.map((t: any) => t.payee);
    expect(await names(sam)).toContain('Bookstore');
    expect(await names(sam)).not.toContain('Grocer');
    expect(await names('household')).toContain('Grocer');
    expect(await names('household')).not.toContain('Bookstore');
    const d = (await c.get(url(`/dashboard?memberId=${sam}`))).body;
    expect(d).toMatchObject({ memberId: sam, spent: { amount: '4000' } });
  });

  it('counts the pay as arrived whatever the statement calls it (PAY-07)', async () => {
    const robin = (await c.post(url('/family-members'), { name: 'Robin', relationship: 'other' })).body.id;
    const gig = (
      await c.post(url('/employers'), { memberId: robin, name: 'Side Gig', depositAccountId: checking })
    ).body;
    await c.post(url('/transactions'), {
      date: payDate,
      accountId: checking,
      amount: usd('25000'),
      payee: 'XYZ*TRANSFER 0042',
      categoryId: cat('Other income'),
    });
    const lines = [{ section: 'earning', code: 'salary', label: 'Fee', amount: '25000' }];
    const p = (await c.post(url('/payslips'), { employerId: gig.id, payDate })).body;
    const edited = (await c.patch(url(`/payslips/${p.id}`), { lines, net: '25000', version: p.version }))
      .body;
    const posted = (await c.post(url(`/payslips/${p.id}/confirm`), { version: edited.version })).body;
    expect(posted).toMatchObject({ status: 'posted', matchedDeposit: true });

    const cal = (await c.get(url(`/calendar?from=${payDate}&to=${payDate}`))).body;
    expect(cal.items.filter((i: any) => i.name === 'Side Gig').map((i: any) => i.status)).toEqual(['paid']);
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
    await c.delete(url(`/transactions/${posted.transactionId}`));
  });

  it('counts other income tagged to a member with no payslips (PAY-08)', async () => {
    const kid = (await c.post(url('/family-members'), { name: 'Kit', relationship: 'child' })).body.id;
    const gift = (
      await c.post(url('/transactions'), {
        date: payDate,
        accountId: checking,
        amount: usd('5000'),
        payee: 'Scholarship fund',
        categoryId: cat('Other income'),
        memberId: kid,
      })
    ).body;
    const r = (await c.get(url('/reports/by-member'))).body;
    expect(r.members.find((m: any) => m.memberId === kid)).toMatchObject({ name: 'Kit', income: '5000' });
    await c.delete(url(`/transactions/${gift.id}`));
  });

  it('summarizes withholding for a member (PAY-06)', async () => {
    const s = (await c.get(url(`/reports/payslip-summary?memberId=${sam}`))).body;
    expect(s).toMatchObject({ name: 'Sam', year: Number(today.slice(0, 4)) });
    expect(s.ytd).toMatchObject({
      payslips: 1,
      gross: '500000',
      net: NET,
      taxes: '121250',
      retirement: '30000',
      employer: '15000',
      effectiveRateBps: 2425,
    });
    expect(s.priorYear).toMatchObject({ payslips: 0, gross: '0', effectiveRateBps: null });
    expect(s.byTax.map((t: any) => t.code).sort()).toEqual([
      'fed_tax',
      'medicare',
      'social_security',
      'state_tax',
    ]);
  });
});

describe('splitting pay across accounts (ADR-0022)', () => {
  // Pays 150,000 net. Amounts here are unlike the rest of this file, so nothing else could be taken for its deposit.
  const SPLIT_LINES = [
    { section: 'earning', code: 'salary', label: 'Salary', amount: '200000' },
    { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '50000' },
  ];
  const SPLIT_NET = '150000';
  let splitCo: any;
  let college: string;
  let vacation: string;
  const when = addDays(payDate, 14);

  const account = async (name: string, kind = 'savings', currency = 'USD') =>
    (
      await c.post(url('/accounts'), {
        name,
        kind,
        ...(currency !== 'USD' ? { currency } : {}),
        openingBalance: { amount: '0', currency },
        openingDate: addDays(payDate, -40),
      })
    ).body.id as string;

  const slip = async (date = when, net = SPLIT_NET, lines: object[] = SPLIT_LINES) => {
    const p = (await c.post(url('/payslips'), { employerId: splitCo.id, payDate: date })).body;
    const res = await c.patch(url(`/payslips/${p.id}`), { lines, net, version: p.version });
    expect(res.status).toBe(200);
    return res.body;
  };

  const confirm = (p: any, extra: object = {}) =>
    c.post(url(`/payslips/${p.id}/confirm`), { version: p.version, ...extra });

  const incomeOf = async (payslipId: string, version?: number) => {
    const { rows } = await admin.query(
      `select coalesce(sum(p.amount_minor), 0)::text as total
         from app.posting p
         join app.journal_entry e on e.workspace_id = p.workspace_id and e.id = p.journal_entry_id
         join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
         join app.transaction t on t.workspace_id = e.workspace_id and t.id = e.transaction_id
        where a.type = 'income' and t.spec->>'payslipId' = $1`,
      [payslipId],
    );
    expect(version).toBeUndefined();
    return rows[0].total as string;
  };

  beforeAll(async () => {
    college = await account('College fund');
    vacation = await account('Vacation');
    const res = await c.post(url('/employers'), {
      memberId: sam,
      name: 'Split Co',
      depositAccountId: checking,
      deposits: [
        { accountId: college, amount: '20000' },
        { accountId: vacation, amount: '10000' },
      ],
    });
    expect(res.status).toBe(201);
    splitCo = res.body;
  });

  it('keeps the plan on the employer', async () => {
    expect(splitCo.deposits).toEqual([
      { accountId: college, amount: '20000' },
      { accountId: vacation, amount: '10000' },
    ]);
    const listed = (await c.get(url('/employers'))).body.data.find((e: any) => e.id === splitCo.id);
    expect(listed.deposits).toEqual(splitCo.deposits);
    // An employer with no split is as before.
    expect(
      (await c.get(url('/employers'))).body.data.find((e: any) => e.id === employer.id).deposits,
    ).toEqual([]);
  });

  it('refuses a split that couldn’t work', async () => {
    const plan = (deposits: object[]) =>
      c.patch(url(`/employers/${splitCo.id}`), { deposits, version: splitCo.version });
    const code = async (deposits: object[]) => {
      const res = await plan(deposits);
      return [res.status, res.body.code];
    };
    expect(await code([{ accountId: checking, amount: '100' }])).toEqual([422, 'payslip.deposit_main']);
    expect(await code([{ accountId: cat('Salary'), amount: '100' }])).toEqual([422, 'employer.account']);
    expect((await plan([{ accountId: college, amount: '0' }])).status).toBe(400);
    expect((await plan([{ accountId: college, amount: '-5' }])).status).toBe(400);
    expect(
      (
        await plan([
          { accountId: college, amount: '1' },
          { accountId: college, amount: '2' },
        ])
      ).status,
    ).toBe(400);
    const euro = await account('Euro savings', 'savings', 'EUR');
    expect(await code([{ accountId: euro, amount: '100' }])).toEqual([422, 'payslip.deposit_currency']);
  });

  it('changes a plan, and moving the main account into the split is refused', async () => {
    const res = await c.patch(url(`/employers/${splitCo.id}`), {
      deposits: [{ accountId: college, amount: '20000' }],
      version: splitCo.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.deposits).toEqual([{ accountId: college, amount: '20000' }]);
    const moved = await c.patch(url(`/employers/${splitCo.id}`), {
      depositAccountId: college,
      version: res.body.version,
    });
    expect(moved.body.code).toBe('payslip.deposit_main');
    const back = await c.patch(url(`/employers/${splitCo.id}`), {
      deposits: [
        { accountId: college, amount: '20000' },
        { accountId: vacation, amount: '10000' },
      ],
      version: res.body.version,
    });
    expect(back.status).toBe(200);
    splitCo = back.body;
  });

  it('starts a payslip from the plan, and shows what’s left for the main account', async () => {
    const p = await slip();
    expect(p.deposits).toEqual([
      { accountId: college, amount: '20000', transactionId: null, matchedDeposit: false },
      { accountId: vacation, amount: '10000', transactionId: null, matchedDeposit: false },
    ]);
    expect(p.mainDeposit).toBe('120000');
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('lets this one payslip differ, without touching the plan', async () => {
    const p = await slip();
    const res = await c.patch(url(`/payslips/${p.id}`), {
      deposits: [{ accountId: vacation, amount: '50000' }],
      version: p.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.mainDeposit).toBe('100000');
    expect(res.body.deposits.map((d: any) => d.accountId)).toEqual([vacation]);
    const listed = (await c.get(url('/employers'))).body.data.find((e: any) => e.id === splitCo.id);
    expect(listed.deposits).toHaveLength(2);
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('posts each amount to its account, with total income exactly what it was', async () => {
    const before = {
      checking: BigInt(await balance(c, checking)),
      college: BigInt(await balance(c, college)),
      vacation: BigInt(await balance(c, vacation)),
    };
    const p = await slip();
    const res = await confirm(p);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('posted');
    expect(BigInt(await balance(c, checking))).toBe(before.checking + 120000n);
    expect(BigInt(await balance(c, college))).toBe(before.college + 20000n);
    expect(BigInt(await balance(c, vacation))).toBe(before.vacation + 10000n);
    // Credits are negative: 200,000 of salary in all, over three entries.
    expect(await incomeOf(p.id)).toBe('-200000');

    const [one, two] = res.body.deposits;
    expect(one.transactionId).toBeTruthy();
    expect(two.transactionId).toBeTruthy();
    expect(new Set([res.body.transactionId, one.transactionId, two.transactionId]).size).toBe(3);
    const t = (await c.get(url(`/transactions/${one.transactionId}`))).body;
    expect(t.amount).toEqual(usd('20000'));
    expect(t.date).toBe(when);

    // Each entry balances by itself.
    const { rows } = await admin.query(
      `select e.id, sum(p.functional_amount_minor)::text as total
         from app.journal_entry e join app.posting p on p.workspace_id = e.workspace_id and p.journal_entry_id = e.id
         join app.transaction t on t.workspace_id = e.workspace_id and t.id = e.transaction_id
        where t.spec->>'payslipId' = $1 group by e.id`,
      [p.id],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.total === '0')).toBe(true);
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('takes over each account’s own statement line, so nothing is counted twice (PAY-04)', async () => {
    const date = addDays(when, 1);
    const line = async (accountId: string, amount: string) =>
      (
        await c.post(url('/transactions'), {
          date: addDays(date, 1),
          accountId,
          amount: usd(amount),
          payee: 'SPLIT CO',
          categoryId: cat('Other income'),
        })
      ).body;
    const main = await line(checking, '120000');
    const one = await line(college, '20000');
    const two = await line(vacation, '10000');
    const before = [await balance(c, checking), await balance(c, college), await balance(c, vacation)];

    const p = await slip(date);
    const res = await confirm(p);
    expect(res.body).toMatchObject({ status: 'posted', transactionId: main.id, matchedDeposit: true });
    expect(res.body.deposits).toEqual([
      { accountId: college, amount: '20000', transactionId: one.id, matchedDeposit: true },
      { accountId: vacation, amount: '10000', transactionId: two.id, matchedDeposit: true },
    ]);
    expect([await balance(c, checking), await balance(c, college), await balance(c, vacation)]).toEqual(
      before,
    );
    // The statement's date stays.
    expect((await c.get(url(`/transactions/${one.id}`))).body.date).toBe(addDays(date, 1));
    expect(await incomeOf(p.id)).toBe('-200000');

    // Deleting gives all three plain deposits back, with the same money where it was.
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
    expect([await balance(c, checking), await balance(c, college), await balance(c, vacation)]).toEqual(
      before,
    );
    expect((await c.get(url(`/transactions/${one.id}`))).body.amount).toEqual(usd('20000'));
    for (const t of [main, one, two])
      expect((await c.delete(url(`/transactions/${t.id}`))).status).toBeLessThan(300);
  });

  it('asks when an account has more than one possible deposit, and only about that account', async () => {
    const date = addDays(when, 2);
    const line = async (accountId: string, amount: string, on = date) =>
      (
        await c.post(url('/transactions'), {
          date: on,
          accountId,
          amount: usd(amount),
          payee: 'SPLIT CO',
          categoryId: cat('Other income'),
        })
      ).body;
    const a = await line(college, '20000');
    const b = await line(college, '20000', addDays(date, 1));
    const p = await slip(date);
    const asked = (await confirm(p)).body;
    expect(asked.status).toBe('needs_review');
    expect(asked.matchCandidates.map((x: any) => [x.accountId, x.transactionId])).toEqual([
      [college, a.id],
      [college, b.id],
    ]);
    // Nothing has posted yet.
    expect(asked.deposits.every((d: any) => d.transactionId === null)).toBe(true);

    // A deposit from another account can't stand in.
    const wrong = await confirm(asked, {
      otherDeposits: [
        { accountId: college, transactionId: b.id },
        { accountId: vacation, transactionId: a.id },
      ],
    });
    expect(wrong.body.code).toBe('payslip.deposit_account');
    // That all rolled back: still nothing posted.
    expect((await c.get(url(`/payslips/${p.id}`))).body.status).toBe('needs_review');
    expect((await c.get(url(`/transactions/${b.id}`))).body.amount).toEqual(usd('20000'));

    const done = (await confirm(asked, { otherDeposits: [{ accountId: college, transactionId: b.id }] }))
      .body;
    expect(done.status).toBe('posted');
    expect(done.deposits[0]).toMatchObject({ transactionId: b.id, matchedDeposit: true });
    expect(done.deposits[1]).toMatchObject({ matchedDeposit: false });
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
    for (const t of [a, b]) expect((await c.delete(url(`/transactions/${t.id}`))).status).toBeLessThan(300);
  });

  it('has to leave something for the main account', async () => {
    const p = await slip();
    const res = await c.patch(url(`/payslips/${p.id}`), {
      deposits: [{ accountId: college, amount: SPLIT_NET }],
      version: p.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.mainDeposit).toBe('0');
    const refused = await confirm(res.body);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('payslip.deposits_too_big');
    expect((await c.get(url(`/payslips/${p.id}`))).body.status).toBe('needs_review');
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('won’t change the split after posting, but a corrected net still lands on the main account', async () => {
    const before = BigInt(await balance(c, checking));
    const p = await slip();
    const posted = (await confirm(p)).body;
    const changed = await c.patch(url(`/payslips/${p.id}`), {
      deposits: [{ accountId: college, amount: '1' }],
      version: posted.version,
    });
    expect(changed.body.code).toBe('payslip.deposits_posted');

    const collegeBefore = await balance(c, college);
    const lines = [SPLIT_LINES[0], { ...SPLIT_LINES[1], amount: '60000' }];
    const fixed = await c.patch(url(`/payslips/${p.id}`), { lines, net: '140000', version: posted.version });
    expect(fixed.status).toBe(200);
    expect(fixed.body.mainDeposit).toBe('110000');
    expect(BigInt(await balance(c, checking))).toBe(before + 110000n);
    expect(await balance(c, college)).toBe(collegeBefore);
    expect(await incomeOf(p.id)).toBe('-200000');

    // Too small a net for the split is refused, and changes nothing.
    const small = await c.patch(url(`/payslips/${p.id}`), {
      lines: [SPLIT_LINES[0], { ...SPLIT_LINES[1], amount: '180000' }],
      net: '20000',
      version: fixed.body.version,
    });
    expect(small.status).toBe(422);
    expect(BigInt(await balance(c, checking))).toBe(before + 110000n);
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
    expect(BigInt(await balance(c, checking))).toBe(before);
  });

  it('removes all of it when the payslip goes, and leaves the other accounts as they were', async () => {
    const before = [await balance(c, checking), await balance(c, college), await balance(c, vacation)];
    const p = await slip();
    const posted = (await confirm(p)).body;
    const ids = [posted.transactionId, ...posted.deposits.map((d: any) => d.transactionId)];
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
    expect([await balance(c, checking), await balance(c, college), await balance(c, vacation)]).toEqual(
      before,
    );
    for (const id of ids) expect((await c.get(url(`/transactions/${id}`))).body.status).toBe('void');
    const left = await admin.query(`select 1 from app.payslip_deposit where payslip_id = $1`, [p.id]);
    expect(left.rows).toEqual([]);
  });

  it('only changes through the payslip, like the main deposit', async () => {
    const p = await slip();
    const posted = (await confirm(p)).body;
    const id = posted.deposits[0].transactionId;
    const t = (await c.get(url(`/transactions/${id}`))).body;
    const edit = await c.patch(url(`/transactions/${id}`), { amount: usd('1'), version: t.version });
    expect(edit.status).toBeGreaterThanOrEqual(400);
    expect((await c.delete(url(`/transactions/${id}`))).status).toBeGreaterThanOrEqual(400);
    expect((await c.get(url(`/transactions/${id}`))).body.amount).toEqual(usd('20000'));
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });

  it('shows others the bank fact on each account, and none of the pay (PAY-09)', async () => {
    const p = await slip();
    const posted = (await confirm(p)).body;
    const id = posted.deposits[0].transactionId;
    const seen = await partner.get(url(`/transactions/${id}`));
    expect(seen.status).toBe(200);
    expect(seen.body.amount).toEqual(usd('20000'));
    expect(JSON.stringify(seen.body)).not.toContain('Federal');
    expect((await partner.get(url(`/payslips/${p.id}`))).status).toBe(404);
    // Who can see a payslip is who can see its split.
    const { rows } = await admin.query(
      `select count(*)::int as n from app.payslip_deposit where payslip_id = $1`,
      [p.id],
    );
    expect(rows[0].n).toBe(2);
    expect((await c.delete(url(`/payslips/${p.id}`))).status).toBe(204);
  });
});
