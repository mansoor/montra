/**
 * The books' side of a tax form's checks (ADR-0052 §5): the figures the pure rules in `@montra/domain` compare the form
 * with, gathered under the reader's own row-level security. A check never reveals more than the form: the person,
 * owners and admins can read that member's payslips already, and an accountant gets a W-2's payslip sums from
 * `app.tax_form_payslip_totals`, without the payslips (§8.4).
 */
import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '@montra/db';
import {
  accountProfile,
  addDays,
  boundaryWindow,
  calendarDate,
  emptySum,
  principalDate,
  type AccountIncomeBooks,
  type CalendarDate,
  type ExpectedFromAccount,
  type ExpectedFromEmployer,
  type Form1098Boxes,
  type MortgageBooks,
  type MortgagePayment,
  type PostingSum,
  type W2Books,
  type W2PayslipSums,
} from '@montra/domain';
import { incomeCategory, type IncomeKind } from '../accounts/income-categories.js';

type Ctx = { workspaceId: string; userId: string };

const iso = (v: unknown): CalendarDate =>
  calendarDate(String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
const yearStart = (y: number) => `${y}-01-01` as CalendarDate;
const yearEnd = (y: number) => `${y}-12-31` as CalendarDate;

// ----- W-2 -------------------------------------------------------------------------------------------------------------

const NO_SUMS: W2PayslipSums = {
  earnings: 0n,
  preTax: 0n,
  preTax401k: 0n,
  hsa: 0n,
  roth401k: 0n,
  fedTax: 0n,
  socialSecurity: 0n,
  medicare: 0n,
  stateTax: 0n,
};

/** The §5.2 sums of payslip lines, from their amounts or their year-to-date figures. */
function sumsOf(lines: readonly { section: string; code: string; amount: bigint }[]): W2PayslipSums {
  const s = { ...NO_SUMS };
  for (const l of lines) {
    if (l.section === 'earning') s.earnings += l.amount;
    if (l.section === 'pre_tax') s.preTax += l.amount;
    if (l.section === 'pre_tax' && l.code === '401k') s.preTax401k += l.amount;
    if ((l.section === 'pre_tax' || l.section === 'employer') && l.code === 'hsa') s.hsa += l.amount;
    if (l.section === 'post_tax' && l.code === 'roth_401k') s.roth401k += l.amount;
    if (l.section === 'tax' && l.code === 'fed_tax') s.fedTax += l.amount;
    if (l.section === 'tax' && l.code === 'social_security') s.socialSecurity += l.amount;
    if (l.section === 'tax' && l.code === 'medicare') s.medicare += l.amount;
    if (l.section === 'tax' && l.code === 'state_tax') s.stateTax += l.amount;
  }
  return s;
}

/**
 * A W-2's books: the sums from `app.tax_form_payslip_totals` (the one place §5.2's sums are worked out, for every
 * reader), then what the reader may see of the payslips themselves for the drill-down, the pay dates and the
 * year-to-date cross-check. An accountant sees none of those (PAY-09), so gets the totals alone.
 */
export async function w2Books(
  trx: Trx,
  ctx: Ctx,
  form: { id: string; tax_year: number; person_member_id: string | null },
  employerIds: readonly string[],
): Promise<W2Books> {
  const { rows } = await sql<{
    payslips: number;
    earnings: string;
    pre_tax: string;
    pre_tax_401k: string;
    hsa: string;
    roth_401k: string;
    fed_tax: string;
    social_security: string;
    medicare: string;
    state_tax: string;
  }>`select * from app.tax_form_payslip_totals(${form.id}::uuid)`.execute(trx);
  const t = rows[0];
  const sums: W2PayslipSums = t
    ? {
        earnings: BigInt(t.earnings),
        preTax: BigInt(t.pre_tax),
        preTax401k: BigInt(t.pre_tax_401k),
        hsa: BigInt(t.hsa),
        roth401k: BigInt(t.roth_401k),
        fedTax: BigInt(t.fed_tax),
        socialSecurity: BigInt(t.social_security),
        medicare: BigInt(t.medicare),
        stateTax: BigInt(t.state_tax),
      }
    : NO_SUMS;
  const books: W2Books = {
    payslips: t?.payslips ?? 0,
    sums,
    ytd: null,
    payDates: [],
    otherPreTax: [],
    payslipIds: [],
  };
  if (!t || !form.person_member_id || employerIds.length === 0) return books;

  // What this reader may see of the payslips (none, for an accountant).
  const payslips = await trx
    .selectFrom('app.payslip')
    .select(['id', 'pay_date'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('member_id', '=', form.person_member_id)
    .where('employer_id', 'in', [...employerIds])
    .where('status', '=', 'posted')
    .where('pay_date', '>=', yearStart(form.tax_year))
    .where('pay_date', '<=', yearEnd(form.tax_year))
    .orderBy('pay_date')
    .orderBy('created_at')
    .execute();
  if (payslips.length === 0) return books;
  books.payslipIds = payslips.map((p) => p.id);
  books.payDates = payslips.map((p) => iso(p.pay_date));
  const lines = await trx
    .selectFrom('app.payslip_line')
    .select(['payslip_id', 'section', 'code', 'label', 'amount_minor', 'ytd_minor'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('payslip_id', 'in', books.payslipIds)
    .execute();
  books.otherPreTax = [
    ...new Set(lines.filter((l) => l.section === 'pre_tax' && l.code === 'other').map((l) => l.label)),
  ].sort();
  const last = payslips.at(-1)!;
  const withYtd = lines.filter((l) => l.payslip_id === last.id && l.ytd_minor !== null);
  if (withYtd.length > 0) {
    books.ytd = {
      sums: sumsOf(withYtd.map((l) => ({ section: l.section, code: l.code, amount: BigInt(l.ytd_minor!) }))),
      payDate: iso(last.pay_date),
    };
  }
  return books;
}

// ----- 1099-INT and 1099-DIV -------------------------------------------------------------------------------------------

interface EntryAmount {
  entry_id: string;
  transaction_id: string | null;
  entry_date: string;
  amount: string;
}

/**
 * The ids of the ledger accounts (aliased `c`) a condition picks. Looked up first, so the postings are read through
 * their account's index rather than by scanning the year's postings.
 */
async function categoryIds(trx: Trx, ctx: Ctx, category: RawBuilder<boolean>): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    select c.id from app.ledger_account c where c.workspace_id = ${ctx.workspaceId} and ${category}`.execute(
    trx,
  );
  return rows.map((r) => r.id);
}

/**
 * Postings to the categories `category` (the ledger account aliased `c`) in entries that move money on one of the
 * accounts, per entry, between two dates. `sign` −1 reads income (credits) as positive; 1 reads expenses.
 */
async function categoryPostings(
  trx: Trx,
  ctx: Ctx,
  accountIds: readonly string[],
  from: CalendarDate,
  to: CalendarDate,
  category: RawBuilder<boolean>,
  opts: { sign: 1 | -1; moneyIn: boolean },
): Promise<{ entryId: string; transactionId: string | null; date: CalendarDate; amount: bigint }[]> {
  if (accountIds.length === 0) return [];
  const categories = await categoryIds(trx, ctx, category);
  if (categories.length === 0) return [];
  const { rows } = await sql<EntryAmount>`
    select i.journal_entry_id as entry_id, je.transaction_id, i.entry_date::text as entry_date,
           (${sql.lit(opts.sign)} * sum(i.amount_minor))::text as amount
      from app.posting i
      join app.journal_entry je on je.workspace_id = i.workspace_id and je.id = i.journal_entry_id
     where i.workspace_id = ${ctx.workspaceId} and i.ledger_account_id = any(${categories}::uuid[])
       and i.entry_date between ${from} and ${to}
       and exists (select 1 from app.posting p
                    where p.workspace_id = i.workspace_id and p.journal_entry_id = i.journal_entry_id
                      and p.ledger_account_id = any(${[...accountIds]}::uuid[])
                      ${opts.moneyIn ? sql`and p.amount_minor > 0` : sql``})
     group by i.journal_entry_id, je.transaction_id, i.entry_date
     order by i.entry_date, i.journal_entry_id`.execute(trx);
  return rows.map((r) => ({
    entryId: r.entry_id,
    transactionId: r.transaction_id,
    date: iso(r.entry_date),
    amount: BigInt(r.amount),
  }));
}

function toSum(
  rows: readonly { entryId: string; transactionId: string | null; amount: bigint }[],
): PostingSum {
  const s = emptySum();
  for (const r of rows) {
    s.total += r.amount;
    if (r.transactionId) {
      if (!s.transactionIds.includes(r.transactionId)) s.transactionIds.push(r.transactionId);
    } else s.journalEntryIds.push(r.entryId);
  }
  return s;
}

const FEDERAL_TAX = sql<boolean>`(c.type = 'expense' and c.is_category and c.name not ilike '%foreign%'
  and (c.name ilike '%withh%' or c.name ilike '%federal%tax%' or c.name ilike '%income tax%'))`;
const FOREIGN_TAX = sql<boolean>`(c.type = 'expense' and c.is_category and c.name ilike '%foreign%tax%')`;
const PENALTIES = sql<boolean>`(c.type = 'expense' and (c.system_role = 'bank_fees'
  or (c.is_category and (c.name ilike '%penalt%' or c.name ilike '%fee%'))))`;

/** Whether any of the accounts is valued rather than itemized (an investment), so income may never be posted to it. */
async function anyValued(trx: Trx, ctx: Ctx, accountIds: readonly string[]): Promise<boolean> {
  if (accountIds.length === 0) return false;
  const kinds = await trx
    .selectFrom('app.bank_account')
    .select('kind')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('ledger_account_id', 'in', [...accountIds])
    .execute();
  return kinds.some((k) => accountProfile(k.kind).balanceWord === 'value');
}

/** A 1099's books: the year's interest or dividends on its account(s), the boundary postings, and the taxes. */
export async function accountIncomeBooks(
  trx: Trx,
  ctx: Ctx,
  year: number,
  accountIds: readonly string[],
  kind: IncomeKind,
): Promise<AccountIncomeBooks> {
  const window = boundaryWindow(year);
  const all = await categoryPostings(
    trx,
    ctx,
    accountIds,
    window.before[0],
    window.after[1],
    incomeCategory('c', kind),
    {
      sign: -1,
      moneyIn: true,
    },
  );
  const inYear = all.filter((r) => r.date >= yearStart(year) && r.date <= yearEnd(year));
  const range = [yearStart(year), yearEnd(year)] as const;
  const [federalTax, foreignTax, penalties] = await Promise.all(
    [FEDERAL_TAX, FOREIGN_TAX, PENALTIES].map(async (c) =>
      toSum(await categoryPostings(trx, ctx, accountIds, range[0], range[1], c, { sign: 1, moneyIn: false })),
    ),
  );
  const income = toSum(inYear);
  return {
    income,
    // Only income credited, not one taken back, can be on the wrong side of 1 January.
    boundary: all
      .filter(
        (r) =>
          r.amount > 0n &&
          (r.date < addDays(yearStart(year), 5) || r.date >= addDays(yearStart(year + 1), -5)),
      )
      .map((r) => ({ date: r.date, amount: r.amount })),
    // Nothing posted, or only entries that cancel out: a valued account doesn't itemize this income.
    tracked: income.total !== 0n || !(await anyValued(trx, ctx, accountIds)),
    federalTax: federalTax!,
    foreignTax: foreignTax!,
    penalties: penalties!,
  };
}

// ----- 1098 ------------------------------------------------------------------------------------------------------------

/** A 1098's books: the matched mortgage's payments around the year, its balance, and escrow's taxes. */
export async function mortgageBooks(
  trx: Trx,
  ctx: Ctx,
  year: number,
  accountId: string,
  boxes: Form1098Boxes,
): Promise<MortgageBooks> {
  const loan = await trx
    .selectFrom('app.loan_schedule')
    .select(['id', 'start_date', 'first_payment_date'])
    .where('workspace_id', '=', ctx.workspaceId)
    .where('loan_account_id', '=', accountId)
    .orderBy('created_at')
    .executeTakeFirst();
  const window = boundaryWindow(year);
  const payments: MortgagePayment[] = [];
  if (loan) {
    const rows = await trx
      .selectFrom('app.loan_payment as lp')
      .innerJoin('app.transaction as t', (j) =>
        j.onRef('t.workspace_id', '=', 'lp.workspace_id').onRef('t.id', '=', 'lp.transaction_id'),
      )
      .select(['lp.id', 'lp.transaction_id', 'lp.interest_minor', 't.txn_date'])
      .where('lp.workspace_id', '=', ctx.workspaceId)
      .where('lp.loan_id', '=', loan.id)
      .where('t.deleted_at', 'is', null)
      .where('t.status', '!=', 'void')
      .where('t.txn_date', '>=', window.before[0])
      .where('t.txn_date', '<=', window.after[1])
      .orderBy('t.txn_date')
      .execute();
    for (const r of rows) {
      payments.push({
        date: iso(r.txn_date),
        interest: BigInt(r.interest_minor ?? 0),
        loanPaymentId: r.id,
        transactionId: r.transaction_id,
      });
    }
  }
  const inYear = payments.filter((p) => p.date >= yearStart(year) && p.date <= yearEnd(year));

  const on = principalDate(year, boxes);
  const { rows: balance } = await sql<{ total: string | null; postings: number }>`
    select (-sum(amount_minor))::text as total, count(*)::integer as postings from app.posting
     where workspace_id = ${ctx.workspaceId} and ledger_account_id = ${accountId} and entry_date <= ${on}`.execute(
    trx,
  );
  const principal =
    balance[0] && balance[0].postings > 0
      ? { amount: BigInt(balance[0].total ?? '0'), date: on, journalEntryIds: [] }
      : null;

  // Escrow's parts posted with the year's payments.
  const txns = inYear.map((p) => p.transactionId);
  const parts = async (category: RawBuilder<boolean>): Promise<PostingSum | null> => {
    if (txns.length === 0) return null;
    const { rows } = await sql<{ transaction_id: string; amount: string }>`
      select je.transaction_id, sum(i.amount_minor)::text as amount
        from app.posting i
        join app.ledger_account c on c.workspace_id = i.workspace_id and c.id = i.ledger_account_id
        join app.journal_entry je on je.workspace_id = i.workspace_id and je.id = i.journal_entry_id
       where i.workspace_id = ${ctx.workspaceId} and je.transaction_id = any(${txns}::uuid[]) and ${category}
       group by je.transaction_id`.execute(trx);
    if (rows.length === 0) return null;
    return toSum(
      rows.map((r) => ({
        entryId: r.transaction_id,
        transactionId: r.transaction_id,
        amount: BigInt(r.amount),
      })),
    );
  };
  const escrowTaxes =
    (await parts(sql<boolean>`(c.type = 'expense' and c.is_category and c.name not ilike '%insurance%'
      and (c.tax_line_code = 'US_SCH_E_L16' or c.name ilike '%tax%'))`)) ?? emptySum();
  const mortgageInsurance = await parts(
    sql<boolean>`(c.type = 'expense' and c.is_category and (c.name ilike '%mortgage insurance%' or c.name ilike '%pmi%'))`,
  );
  return {
    tracked: inYear.length > 0,
    payments: inYear,
    boundary: payments,
    principal,
    startDate: loan ? iso(loan.start_date ?? loan.first_payment_date) : null,
    escrowTaxes,
    mortgageInsurance,
  };
}

// ----- Expected forms (§7.1) --------------------------------------------------------------------------------------------

/** What the expected forms are inferred from: employers with payslips, and accounts with interest, dividends or a mortgage. */
export async function expectedInputs(
  trx: Trx,
  ctx: Ctx,
  year: number,
): Promise<{ employers: ExpectedFromEmployer[]; accounts: ExpectedFromAccount[] }> {
  const from = yearStart(year);
  const to = yearEnd(year);
  const { rows: employers } = await sql<{
    id: string;
    name: string;
    member_id: string;
    entity_id: string;
    type: string;
    payslips: number;
    earnings: string;
  }>`
    select e.id, e.name, e.member_id, e.entity_id, e.type, count(p.id)::integer as payslips,
           coalesce(sum(p.gross_minor), 0)::text as earnings
      from app.employer e
      join app.payslip p on p.workspace_id = e.workspace_id and p.employer_id = e.id
       and p.status = 'posted' and p.pay_date between ${from} and ${to}
     where e.workspace_id = ${ctx.workspaceId}
     group by e.id, e.name, e.member_id, e.entity_id, e.type
     order by e.name`.execute(trx);

  const income = async (kind: IncomeKind) => {
    const categories = await categoryIds(trx, ctx, incomeCategory('c', kind));
    if (categories.length === 0) return new Map<string, bigint>();
    const { rows } = await sql<{ account_id: string; amount: string }>`
      select p.ledger_account_id as account_id, (-sum(i.amount_minor))::text as amount
        from app.posting i
        join app.posting p on p.workspace_id = i.workspace_id and p.journal_entry_id = i.journal_entry_id
         and p.amount_minor > 0
        join app.bank_account b on b.workspace_id = p.workspace_id and b.ledger_account_id = p.ledger_account_id
       where i.workspace_id = ${ctx.workspaceId} and i.ledger_account_id = any(${categories}::uuid[])
         and i.entry_date between ${from} and ${to}
       group by p.ledger_account_id`.execute(trx);
    return new Map(rows.map((r) => [r.account_id, BigInt(r.amount)]));
  };
  const [interest, dividends] = [await income('interest'), await income('dividends')];
  const { rows: mortgages } = await sql<{ account_id: string; interest: string }>`
    select l.loan_account_id as account_id, coalesce(sum(lp.interest_minor), 0)::text as interest
      from app.loan_schedule l
      join app.bank_account b on b.workspace_id = l.workspace_id and b.ledger_account_id = l.loan_account_id
       and b.kind = 'mortgage'
      left join app.loan_payment lp on lp.workspace_id = l.workspace_id and lp.loan_id = l.id
       and exists (select 1 from app.transaction t
                    where t.workspace_id = lp.workspace_id and t.id = lp.transaction_id and t.deleted_at is null
                      and t.status <> 'void' and t.txn_date between ${from} and ${to})
     where l.workspace_id = ${ctx.workspaceId}
     group by l.loan_account_id`.execute(trx);
  const mortgageInterest = new Map(mortgages.map((r) => [r.account_id, BigInt(r.interest)]));

  const accounts = await trx
    .selectFrom('app.bank_account as b')
    .innerJoin('app.ledger_account as a', (j) =>
      j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
    )
    .select(['a.id', 'a.name', 'a.entity_id', 'b.default_member_id', 'b.plan_type'])
    .where('b.workspace_id', '=', ctx.workspaceId)
    .orderBy('a.name')
    .execute();
  return {
    employers: employers.map((e) => ({
      id: e.id,
      name: e.name,
      memberId: e.member_id,
      entityId: e.entity_id,
      type: e.type,
      payslips: e.payslips,
      earnings: BigInt(e.earnings),
    })),
    accounts: accounts
      .map((a) => ({
        id: a.id,
        name: a.name,
        entityId: a.entity_id,
        personMemberId: a.default_member_id,
        planType: a.plan_type,
        interest: interest.get(a.id) ?? 0n,
        dividends: dividends.get(a.id) ?? 0n,
        mortgageInterest: mortgageInterest.get(a.id) ?? null,
      }))
      .filter((a) => a.interest > 0n || a.dividends > 0n || a.mortgageInterest !== null),
  };
}
