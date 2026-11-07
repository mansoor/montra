/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, JOURNAL_KINDS, startOfMonth, SYSTEM_ROLES, todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import { startHarness, type Client, type Harness } from './harness.js';

// Retirement accounts fed by payslips, employer contributions, statement values and gain over time (ADR-0025).
const today = todayIn('UTC');
const payDate = startOfMonth(today);
const usd = (amount: string) => ({ amount, currency: 'USD' });
const EMAIL = 'investments@example.com';

let h: Harness;
let c: Client;
let partner: Client;
let admin: pg.Client;
let url: (p: string) => string;
let checking: string;
let sam: string;
let acme: any;
let k401: string;
let personal: string;

const accountOf = async (who: Client, id: string) =>
  (await who.get(url('/accounts'))).body.data.find((a: any) => a.id === id);
const perfOf = async (who: Client, id: string, range = '1y') =>
  (await who.get(url(`/accounts/${id}/performance?range=${range}`))).body;
let budget: any;
/** The personal budget, made once. */
const budgetOf = async () => {
  budget ??= (await c.post(url('/budgets'), { entityId: personal, name: 'Household' })).body;
  return budget;
};
const values = (id: string, body: object) => c.post(url(`/accounts/${id}/valuations`), body);

/** A payslip for Acme: $5,000 gross, $300 to the 401(k), $100 to an HSA, $1,000 tax, and a $150 match. Net $3,600. */
const payslip = async (employerId: string, date = payDate) => {
  const p = (await c.post(url('/payslips'), { employerId, payDate: date })).body;
  const filled = await c.patch(url(`/payslips/${p.id}`), {
    version: p.version,
    net: '360000',
    lines: [
      { section: 'earning', code: 'salary', label: 'Salary', amount: '500000' },
      { section: 'pre_tax', code: '401k', label: '401(k)', amount: '30000' },
      { section: 'pre_tax', code: 'hsa', label: 'HSA', amount: '10000' },
      { section: 'tax', code: 'fed_tax', label: 'Federal income tax', amount: '100000' },
      { section: 'employer', code: 'match', label: 'Employer match', amount: '15000' },
    ],
  });
  expect(filled.status).toBe(200);
  const posted = await c.post(url(`/payslips/${p.id}/confirm`), { version: filled.body.version });
  expect(posted.status).toBe(200);
  return posted.body;
};

beforeAll(async () => {
  h = await startHarness();
  c = h.as(EMAIL);
  partner = h.as('investments-partner@example.com');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const ws = (
    await c.post('/v1/workspaces', { name: 'Investments', baseCurrency: 'USD', template: 'household' })
  ).body;
  url = (p) => `/v1/workspaces/${ws.id}${p}`;
  personal = ws.entities?.[0]?.id ?? (await c.get(url(''))).body.entities[0].id;
  checking = (
    await c.post(url('/accounts'), {
      name: 'Joint checking',
      kind: 'checking',
      openingBalance: usd('100000'),
      openingDate: addDays(payDate, -40),
    })
  ).body.id;
  sam = (await c.post(url('/family-members'), { name: 'Sam', relationship: 'spouse_partner' })).body.id;
  acme = (await c.post(url('/employers'), { memberId: sam, name: 'Acme', depositAccountId: checking })).body;
  const invite = await c.post(url('/sharing/invites'), {
    email: 'investments-partner@example.com',
    role: 'partner',
  });
  expect((await partner.post(`/v1/invites/${invite.body.token}/accept`)).status).toBeLessThan(300);
});

afterAll(async () => {
  await admin.end();
  await h.close();
});

describe('the database allows what the code writes', () => {
  // A constraint rewritten from an old copy of its list would quietly drop values a later migration added.
  it.each([
    ['ledger_account_system_role_check', SYSTEM_ROLES],
    ['journal_entry_kind_check', JOURNAL_KINDS],
  ] as const)('%s lists exactly the values in the code', async (name, values) => {
    const { rows } = await admin.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`,
      [name],
    );
    const allowed = [...(rows[0].def as string).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(allowed).toEqual([...values].sort());
  });
});

describe('adding a retirement account', () => {
  it('keeps its plan and the employer whose payslips pay in', async () => {
    const res = await c.post(url('/accounts'), {
      name: 'Acme 401(k)',
      kind: 'investment',
      planType: '401k',
      employerId: acme.id,
      employerContributions: true,
      openingDate: addDays(payDate, -40),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ planType: '401k', employerId: acme.id, employerContributions: true });
    k401 = res.body.id;
  });

  it('refuses a plan that can’t work', async () => {
    const code = async (body: object) => (await c.post(url('/accounts'), { name: 'Bad', ...body })).body.code;
    expect(await code({ kind: 'checking', planType: '401k' })).toBe('account.plan_kind');
    expect(await code({ kind: 'investment', planType: 'brokerage', employerId: acme.id })).toBe(
      'account.plan_employer',
    );
    expect(await code({ kind: 'investment', planType: '401k', employerContributions: true })).toBe(
      'account.plan_contributions',
    );
  });

  it('changes a plan, and clears it', async () => {
    const id = (await c.post(url('/accounts'), { name: 'Brokerage', kind: 'investment' })).body.id;
    expect((await c.patch(url(`/accounts/${id}`), { planType: 'roth_ira' })).body.planType).toBe('roth_ira');
    expect((await c.patch(url(`/accounts/${id}`), { planType: null })).body.planType).toBeNull();
    const refused = await c.patch(url(`/accounts/${id}`), { employerId: acme.id });
    expect(refused.body.code).toBe('account.plan_employer');
  });
});

describe('payslips into the plan', () => {
  it('puts the 401(k) and the match in the 401(k), and the HSA where it went before', async () => {
    await payslip(acme.id);
    expect((await accountOf(c, k401)).balance.amount).toBe('45000');
    // No HSA account is linked: it goes to the employer's retirement account, as it always did.
    const fallback = (await c.get(url('/accounts'))).body.data.filter(
      (a: any) => a.name === 'Acme retirement',
    );
    // Exactly one: posting builds the entry more than once, and only the first may make the account.
    expect(fallback).toHaveLength(1);
    expect(fallback[0].balance.amount).toBe('10000');
    const { rows } = await admin.query(
      `select a.name, sum(p.amount_minor)::text as total from app.posting p
         join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
        where a.subtype = 'payroll:employer' and a.workspace_id = (select workspace_id from app.ledger_account where id = $1)
        group by 1`,
      [k401],
    );
    expect(rows).toEqual([{ name: 'Employer contributions', total: '-15000' }]);
  });

  it('keeps the match out of take-home pay in the budget', async () => {
    const budget = await budgetOf();
    const period = (await c.get(url(`/budgets/${budget.id}/periods/current`))).body;
    expect(period.income.actual).toBe('360000');
  });

  it('leaves the match on the payslip when no account takes it', async () => {
    const other = (
      await c.post(url('/employers'), { memberId: sam, name: 'Other Co', depositAccountId: checking })
    ).body;
    const plan = (
      await c.post(url('/accounts'), {
        name: 'Other 401(k)',
        kind: 'investment',
        planType: '401k',
        employerId: other.id,
      })
    ).body.id;
    await payslip(other.id);
    expect((await accountOf(c, plan)).balance.amount).toBe('30000');
  });
});

describe('statement values and gain', () => {
  it('posts what the ledger lacked as a change in value, not income', async () => {
    const incomeNow = async () =>
      (await c.get(url(`/budgets/${(await budgetOf()).id}/periods/current`))).body.income.actual as string;
    const before = await incomeNow();
    const res = await values(k401, { values: [{ date: today, value: '50000', note: 'Q3 statement' }] });
    expect(res.status).toBe(201);
    expect(res.body.data[0]).toMatchObject({
      date: today,
      value: '50000',
      change: '5000',
      note: 'Q3 statement',
    });
    expect((await accountOf(c, k401)).balance.amount).toBe('50000');
    const { rows } = await admin.query(
      `select e.kind, a.name, a.type, p.amount_minor::text as amount from app.posting p
         join app.journal_entry e on e.workspace_id = p.workspace_id and e.id = p.journal_entry_id
         join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
        where e.kind = 'valuation' and p.ledger_account_id <> $1
          and e.workspace_id = (select workspace_id from app.ledger_account where id = $1)`,
      [k401],
    );
    expect(rows).toEqual([
      { kind: 'valuation', name: 'Investment gains and losses', type: 'equity', amount: '-5000' },
    ]);
    expect(await incomeNow()).toBe(before);
  });

  it('works out the gain apart from the money put in', async () => {
    const p = await perfOf(c, k401);
    expect(p).toMatchObject({ hidden: false, range: '1y', currency: 'USD', to: today });
    expect(p.summary).toMatchObject({
      start: '0',
      end: '50000',
      moneyIn: '45000',
      moneyOut: '0',
      gain: '5000',
    });
    expect(p.summary.returnBps).toBeGreaterThan(0);
    expect(p.points[p.points.length - 1]).toEqual({ date: today, value: '50000', invested: '45000' });
    expect(p.periods[0]).toMatchObject({ to: today, gain: '5000' });
  });

  it('doesn’t count a change in value as money moved into savings on the cash-flow chart', async () => {
    const s = (await c.get(url(`/flow/sankey?entityId=${personal}`))).body;
    const node = s.nodes.find((n: any) => n.id === `savings:${k401}`);
    expect(node?.value).toBe('45000');
  });

  it('takes values in order, never in the future, and only on valued accounts', async () => {
    expect((await values(k401, { values: [{ date: addDays(today, -1), value: '1' }] })).body.code).toBe(
      'valuation.order',
    );
    expect((await values(k401, { values: [{ date: addDays(today, 1), value: '1' }] })).body.code).toBe(
      'valuation.future',
    );
    expect((await values(checking, { values: [{ date: today, value: '1' }] })).body.code).toBe(
      'valuation.kind',
    );
    expect((await c.get(url(`/accounts/${checking}/performance`))).body.code).toBe('valuation.kind');
  });

  it('takes several at once, oldest first, and the latest can be taken back', async () => {
    const id = (
      await c.post(url('/accounts'), {
        name: 'Old IRA',
        kind: 'investment',
        planType: 'ira',
        openingBalance: usd('100000'),
        openingDate: addDays(today, -400),
      })
    ).body.id;
    const res = await values(id, {
      values: [
        { date: addDays(today, -300), value: '105000' },
        { date: addDays(today, -100), value: '98000' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.map((v: any) => v.change)).toEqual(['-7000', '5000']);
    const p = await perfOf(c, id, 'all');
    expect(p.summary).toMatchObject({ start: '0', moneyIn: '100000', gain: '-2000', end: '98000' });
    expect(p.summary.annualizedBps).toBeLessThan(0);

    const [latest, earlier] = res.body.data;
    expect((await c.delete(url(`/accounts/${id}/valuations/${earlier.id}`))).body.code).toBe(
      'valuation.not_latest',
    );
    const after = await c.delete(url(`/accounts/${id}/valuations/${latest.id}`));
    expect(after.status).toBe(200);
    expect(after.body.data).toHaveLength(1);
    expect((await accountOf(c, id)).balance.amount).toBe('105000');
  });

  it('values a home or a car the same way', async () => {
    const id = (
      await c.post(url('/accounts'), {
        name: 'Family car',
        kind: 'asset',
        openingBalance: usd('2000000'),
        openingDate: addDays(today, -30),
      })
    ).body.id;
    const res = await values(id, { values: [{ date: today, value: '1850000' }] });
    expect(res.body.data[0].change).toBe('-150000');
  });
});

describe('privacy (PAY-09)', () => {
  it('shows a partner no gain on an account fed by someone’s private payslips, and won’t let them value it', async () => {
    expect(await perfOf(partner, k401)).toMatchObject({ hidden: true, summary: null, points: [] });
    const refused = await partner.post(url(`/accounts/${k401}/valuations`), {
      values: [{ date: today, value: '1' }],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('valuation.private');
    // Their own view of a brokerage account with nothing private is shown in full.
    const mine = (await c.post(url('/accounts'), { name: 'Shared brokerage', kind: 'investment' })).body.id;
    await values(mine, { values: [{ date: today, value: '1000' }] });
    expect((await perfOf(partner, mine)).hidden).toBe(false);
  });
});
