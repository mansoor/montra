/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import pg from 'pg';
import { addDays, addMonths, startOfMonth, todayIn } from '@montra/domain';
import { ADMIN_URL } from './env.js';
import type { Client } from './harness.js';

const usd = (amount: string) => ({ amount, currency: 'USD' });

export interface SeededWorkspace {
  workspaceId: string;
  url: (p: string) => string;
  budgetId: string;
  personalId: string;
  transactions: number;
}

/**
 * The NFR-07 workspace: `count` posted transactions over three years across two entities, with the planning data
 * a real household has (a budget with 36 months of lines, schedules, goals, expected income).
 *
 * Accounts, schedules and goals go through the API. Transactions are bulk-loaded as the owner role, with the row
 * triggers off (through the API this would take about 25 minutes), and the read models are rebuilt the same way
 * migration 0015 backfills them. The ledger stays balanced: every entry gets two equal and opposite postings.
 */
export async function seedWorkspace(c: Client, count: number): Promise<SeededWorkspace> {
  const ws = (
    await c.post('/v1/workspaces', {
      name: 'Perf',
      baseCurrency: 'USD',
      template: 'freelancer',
      businessName: 'Studio',
    })
  ).body;
  const url = (p: string) => `/v1/workspaces/${ws.id}${p}`;
  const personalId: string = ws.entities.find((e: any) => e.type === 'personal').id;
  const businessId: string = ws.entities.find((e: any) => e.type === 'business').id;
  const today = todayIn('UTC');
  const opened = addDays(today, -1100);

  const account = async (name: string, kind: string, opening: string, entityId = personalId) =>
    (
      await c.post(url('/accounts'), {
        entityId,
        name,
        kind,
        openingBalance: usd(opening),
        openingDate: opened,
      })
    ).body.id as string;
  const checking = await account('Checking', 'checking', '5000000');
  const card = await account('Visa', 'credit_card', '100000');
  const savings = await account('Savings', 'savings', '2500000');
  const loan = await account('Car loan', 'loan', '1800000');
  const bizChecking = await account('Business checking', 'checking', '1500000', businessId);

  const cats: any[] = (await c.get(url('/categories'))).body.data;
  const ids = (entityId: string, type: string) =>
    cats.filter((x) => x.entityId === entityId && x.type === type && x.group).map((x) => x.id as string);
  const named = (name: string) => cats.find((x) => x.entityId === personalId && x.name === name).id as string;

  // Schedules, income and goals through the API, as a user would create them.
  for (const [name, amount, category] of [
    ['Rent', '-185000', 'Rent'],
    ['Power', '-12500', 'Utilities'],
    ['Internet', '-7900', 'Phone & internet'],
    ['Streaming', '-1599', 'Subscriptions'],
    ['Gym', '-4500', 'Subscriptions'],
    ['Insurance', '-23000', 'Insurance'],
  ] as const) {
    await c.post(url('/recurring'), {
      name,
      accountId: checking,
      amount: usd(amount),
      payee: name,
      categoryId: named(category),
      cadence: 'monthly',
      startDate: addDays(today, 3),
    });
  }
  await c.post(url('/expected-income'), {
    entityId: personalId,
    name: 'Salary',
    sourceType: 'salary',
    amount: '520000',
    currency: 'USD',
    cadence: 'monthly',
    nextDate: addMonths(startOfMonth(today), -36),
    accountId: checking,
    payee: 'ACME PAYROLL',
  });
  await c.post(url('/goals'), {
    entityId: personalId,
    name: 'Emergency fund',
    type: 'emergency_fund',
    target: '5000000',
    linkedAccountIds: [savings],
  });
  await c.post(url('/goals'), {
    entityId: personalId,
    name: 'Car insurance',
    type: 'sinking_fund',
    target: '144000',
    dueDate: addMonths(today, 4),
  });
  await c.post(url('/goals'), {
    entityId: personalId,
    name: 'Debt free',
    type: 'debt_payoff',
    strategy: 'avalanche',
    linkedAccountIds: [card, loan],
    extraPayment: '20000',
  });
  const budgetId: string = (await c.post(url('/budgets'), { entityId: personalId, name: 'Household' })).body
    .id;

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('begin');
    for (const t of ['transaction', 'journal_entry', 'posting']) {
      await admin.query(`alter table app.${t} disable trigger user`);
    }
    await admin.query(
      `create temp table seed on commit drop as
       select i,
              gen_random_uuid() as txn,
              gen_random_uuid() as je,
              ($1::date - (i % 1095)) as d,
              case when i % 7 = 0 then 'b' else 'p' end as book,
              case when i % 50 = 0 then 'in' else 'out' end as dir,
              (500 + (i * 7919) % 20000)::bigint as amount
         from generate_series(1, $2::int) as i`,
      [today, count],
    );
    await admin.query(
      `alter table seed
         add column entity uuid, add column account uuid, add column category uuid, add column signed bigint`,
    );
    const personalOut = ids(personalId, 'expense');
    const personalIn = ids(personalId, 'income');
    const bizOut = ids(businessId, 'expense');
    const bizIn = ids(businessId, 'income');
    await admin.query(
      `update seed set
         entity = case when book = 'b' then $1::uuid else $2::uuid end,
         account = case when book = 'b' then $3::uuid when i % 2 = 0 then $4::uuid else $5::uuid end,
         category = case
           when book = 'b' and dir = 'in' then ($6::uuid[])[1 + i % cardinality($6::uuid[])]
           when book = 'b' then ($7::uuid[])[1 + i % cardinality($7::uuid[])]
           when dir = 'in' then ($8::uuid[])[1 + i % cardinality($8::uuid[])]
           else ($9::uuid[])[1 + i % cardinality($9::uuid[])] end,
         signed = case when dir = 'in' then amount * 20 else -amount end`,
      [businessId, personalId, bizChecking, checking, card, bizIn, bizOut, personalIn, personalOut],
    );
    await admin.query(
      `insert into app.transaction
         (workspace_id, id, primary_entity_id, txn_date, description, payee_raw, payee_key, status, review_state,
          source, posted_at, spec)
       select $1, txn, entity, d, 'Payee ' || (i % 400), 'Payee ' || (i % 400), 'PAYEE ' || (i % 400), 'posted',
              'reviewed', 'import', now(),
              jsonb_build_object(
                'type', 'standard', 'accountId', account, 'amount', signed::text, 'currency', 'USD',
                'description', 'Payee ' || (i % 400), 'memberId', null, 'uncategorized', false,
                'splits', jsonb_build_array(jsonb_build_object(
                  'accountId', category, 'amount', signed::text, 'memberId', null)))
         from seed`,
      [ws.id],
    );
    await admin.query(
      `insert into app.journal_entry (workspace_id, id, entity_id, transaction_id, entry_date, description)
       select $1, je, entity, txn, d, 'Payee ' || (i % 400) from seed`,
      [ws.id],
    );
    await admin.query(
      `insert into app.posting (workspace_id, journal_entry_id, entity_id, entry_date, line_no, ledger_account_id,
                                amount_minor, currency, functional_amount_minor)
       select $1::uuid, je, entity, d, 1, account, signed, 'USD', signed from seed
       union all
       select $1::uuid, je, entity, d, 2, category, -signed, 'USD', -signed from seed`,
      [ws.id],
    );
    for (const t of ['transaction', 'journal_entry', 'posting']) {
      await admin.query(`alter table app.${t} enable trigger user`);
    }
    // Rebuild the read models from the postings, as migration 0015's backfill does.
    await admin.query('delete from app.category_activity_monthly where workspace_id = $1', [ws.id]);
    await admin.query('delete from app.account_balance_daily where workspace_id = $1', [ws.id]);
    await admin.query(
      `insert into app.category_activity_monthly (workspace_id, entity_id, ledger_account_id, month, member_key,
                                                  restricted, restricted_member_key, activity_minor, postings)
       select workspace_id, entity_id, ledger_account_id, date_trunc('month', entry_date)::date,
              coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid), restricted,
              coalesce(restricted_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
              sum(functional_amount_minor), count(*)
         from app.posting where workspace_id = $1 group by 1, 2, 3, 4, 5, 6, 7`,
      [ws.id],
    );
    await admin.query(
      `insert into app.account_balance_daily (workspace_id, entity_id, ledger_account_id, date, restricted,
                                              restricted_member_key, delta_minor, functional_delta_minor)
       select workspace_id, entity_id, ledger_account_id, entry_date, restricted,
              coalesce(restricted_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
              sum(amount_minor), sum(functional_amount_minor)
         from app.posting where workspace_id = $1 group by 1, 2, 3, 4, 5, 6`,
      [ws.id],
    );
    // 36 months of budget lines: the engine walks every period to compute carried-in amounts.
    await admin.query(
      `with months as (
         select (date_trunc('month', $2::date) - (n || ' months')::interval)::date as start
           from generate_series(0, 35) as n
       ), periods as (
         insert into app.budget_period (workspace_id, budget_id, start_date, end_date)
         select $1::uuid, $3::uuid, start, (start + interval '1 month - 1 day')::date from months
         returning id
       )
       insert into app.budget_line (workspace_id, budget_period_id, category_id, assigned_minor)
       select $1::uuid, p.id, c, 25000 from periods p cross join unnest($4::uuid[]) as c`,
      [ws.id, today, budgetId, personalOut],
    );
    await admin.query('commit');
  } catch (e) {
    await admin.query('rollback');
    throw e;
  }
  for (const t of [
    'transaction',
    'journal_entry',
    'posting',
    'category_activity_monthly',
    'account_balance_daily',
  ]) {
    await admin.query(`analyze app.${t}`);
  }
  await admin.end();
  return { workspaceId: ws.id, url, budgetId, personalId, transactions: count };
}

/** The requests the Home page makes, in parallel, as `app/w/[workspaceId]/page.tsx` does. */
export const homeRequests = (url: (p: string) => string) => [
  url(''),
  url('/accounts'),
  url('/transactions?limit=10'),
  url('/dashboard'),
  url('/recommendations?status=open'),
  url('/categories'),
];
