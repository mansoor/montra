/**
 * Loans and mortgages on any account (RNT-08, ADR-0018 §6, ADR-0024). What's still to pay is computed from what's owed in the
 * ledger, never stored, so an extra payment or a changed rate shows up by itself. Each recorded payment keeps its parts:
 * principal reduces the loan account, interest and escrow go to their categories.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type LoanRow, type Trx } from '@montra/db';
import {
  accountProfile,
  amortize,
  asCurrencyCode,
  calendarDate,
  compareDates,
  monthlyPayment,
  paymentsOnOrBefore,
  projectLoan,
  todayIn,
  type AmortizationRow,
  type CalendarDate,
} from '@montra/domain';
import type {
  AmortizationRowDto,
  CreateLoanRequest,
  LoanDto,
  LoanPaymentRequest,
  UpdateLoanRequest,
} from '@montra/schemas';
import { AccountsService } from '../accounts/accounts.service.js';
import { PaymentLinks } from '../business/payment-links.service.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { NOT_OWNED, type SplitSpec } from '../transactions/poster.js';
import { PropertiesService } from './properties.service.js';
import { categoryOnLine, SCH_E, type Ctx } from './shared.js';

const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));

const termsOf = (r: LoanRow) => ({
  principal: BigInt(r.principal_minor),
  rateBps: r.rate_bps,
  termMonths: r.term_months,
});

const paymentOf = (r: LoanRow): bigint =>
  r.payment_minor !== null ? BigInt(r.payment_minor) : monthlyPayment(termsOf(r));

const escrowOf = (r: LoanRow): bigint => BigInt(r.escrow_taxes_minor) + BigInt(r.escrow_insurance_minor);

/** Categories for a loan outside a rental portfolio, preferred names first, then anything that says what it is. */
const INTEREST_NAMES: Record<string, string[]> = {
  mortgage: ['Mortgage interest', 'Interest & finance charges', 'Interest'],
  loan: ['Interest & finance charges', 'Interest', 'Mortgage interest'],
};

@Injectable()
export class LoansService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PropertiesService) private readonly properties: PropertiesService,
    @Inject(PaymentLinks) private readonly links: PaymentLinks,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  async list(ctx: Ctx, entityId?: string): Promise<LoanDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.loan_schedule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(entityId !== undefined, (q) => q.where('entity_id', '=', entityId!))
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      const out: LoanDto[] = [];
      for (const r of rows) out.push(await this.dto(trx, ctx, r));
      return out;
    });
  }

  async row(trx: Trx, ctx: Ctx, id: string): Promise<LoanRow> {
    const r = await trx
      .selectFrom('app.loan_schedule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Loan');
    return r;
  }

  private async entityOf(trx: Trx, ctx: Ctx, entityId: string) {
    const e = await trx
      .selectFrom('app.entity')
      .select(['id', 'type', 'functional_currency'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', entityId)
      .executeTakeFirst();
    if (!e) throw notFound('Entity');
    return e;
  }

  private async personalEntity(trx: Trx, ctx: Ctx): Promise<string> {
    const e = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', '=', 'personal')
      .executeTakeFirst();
    if (!e) throw notFound('Entity');
    return e.id;
  }

  private async today(trx: Trx, ctx: Ctx): Promise<CalendarDate> {
    const w = await trx
      .selectFrom('app.workspace')
      .select('time_zone')
      .where('id', '=', ctx.workspaceId)
      .executeTakeFirstOrThrow();
    return todayIn(w.time_zone);
  }

  /** It pays from a bank account in the same books and currency, because one payment is one entry (ADR-0005). */
  private async checkPayingAccount(
    trx: Trx,
    ctx: Ctx,
    accountId: string,
    entityId: string,
    currency: string,
  ) {
    const a = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', (j) =>
        j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
      )
      .select(['b.kind', 'a.entity_id', 'a.currency'])
      .where('b.workspace_id', '=', ctx.workspaceId)
      .where('b.ledger_account_id', '=', accountId)
      .executeTakeFirst();
    if (
      !a ||
      accountProfile(a.kind).forecast !== 'cash' ||
      a.entity_id !== entityId ||
      a.currency !== currency
    ) {
      throw unprocessable(
        'loan.paying_account',
        'Choose a bank account in the same books and currency as the loan',
      );
    }
  }

  async create(ctx: Ctx, req: CreateLoanRequest): Promise<LoanDto> {
    return this.db.run(ctx, async (trx) => {
      const property = req.propertyId ? await this.properties.row(trx, ctx, req.propertyId) : null;
      const asOf = req.balanceAsOf ?? (await this.today(trx, ctx));
      const before = req.balanceAsOf
        ? paymentsOnOrBefore(req.firstPaymentDate, req.termMonths, req.balanceAsOf)
        : 0;
      const principal = BigInt(req.principal);
      const level =
        req.paymentAmount !== undefined
          ? BigInt(req.paymentAmount)
          : monthlyPayment({ principal, rateBps: req.rateBps, termMonths: req.termMonths });

      let loanAccountId = req.loanAccountId;
      if (req.newAccount) {
        const entityId =
          req.newAccount.entityId ?? property?.entity_id ?? (await this.personalEntity(trx, ctx));
        const entity = await this.entityOf(trx, ctx, entityId);
        const estimate =
          before === 0
            ? principal
            : (projectLoan({
                balance: principal,
                rateBps: req.rateBps,
                payment: level,
                firstPayment: req.firstPaymentDate,
                termMonths: req.termMonths,
              })[before - 1]?.balance ?? 0n);
        const owed = req.newAccount.owed !== undefined ? BigInt(req.newAccount.owed) : estimate;
        if (owed <= 0n) throw unprocessable('loan.paid_off', 'By these terms this loan is already paid off');
        loanAccountId = await this.accounts.createIn(trx, ctx, {
          name: req.name,
          kind: req.newAccount.kind,
          entityId,
          currency: asCurrencyCode(entity.functional_currency),
          institution: req.newAccount.institution,
          last4: req.newAccount.last4,
          openingBalance: { amount: String(owed), currency: asCurrencyCode(entity.functional_currency) },
          openingDate: asOf,
        });
      }

      const bank = await trx
        .selectFrom('app.bank_account as b')
        .innerJoin('app.ledger_account as a', (j) =>
          j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
        )
        .select(['b.kind', 'a.entity_id', 'a.currency'])
        .where('b.workspace_id', '=', ctx.workspaceId)
        .where('b.ledger_account_id', '=', loanAccountId!)
        .executeTakeFirst();
      if (!bank || !accountProfile(bank.kind).schedule) {
        throw unprocessable('loan.account', 'Choose a loan or mortgage account');
      }
      if (property && bank.entity_id !== property.entity_id) {
        throw unprocessable('loan.account', 'The loan account must be in the same portfolio as the property');
      }
      const entity = await this.entityOf(trx, ctx, bank.entity_id);
      if (bank.currency !== entity.functional_currency) {
        throw unprocessable('loan.currency', 'Tracking payments needs a loan in the currency of its books');
      }
      if (req.payingAccountId) {
        await this.checkPayingAccount(trx, ctx, req.payingAccountId, bank.entity_id, bank.currency);
      }
      if (req.autoRecord && !req.payingAccountId) {
        throw unprocessable(
          'loan.auto_record',
          'Choose the account it’s paid from to record it automatically',
        );
      }

      const existing = await trx
        .selectFrom('app.loan_schedule')
        .select(['id', 'archived_at'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('loan_account_id', '=', loanAccountId!)
        .executeTakeFirst();
      if (existing && existing.archived_at === null) {
        throw unprocessable('loan.exists', 'This account’s payments are already tracked');
      }
      const values = {
        entity_id: bank.entity_id,
        property_id: property?.id ?? null,
        name: req.name,
        start_date: req.startDate ?? null,
        principal_minor: req.principal,
        rate_bps: req.rateBps,
        term_months: req.termMonths,
        first_payment_date: req.firstPaymentDate,
        escrow_taxes_minor: req.escrowTaxes,
        escrow_insurance_minor: req.escrowInsurance,
        paying_account_id: req.payingAccountId ?? null,
        payment_minor: req.paymentAmount ?? null,
        payments_before: before,
        auto_record: req.autoRecord,
      };
      // Tracking the same account again picks its recorded payments back up.
      const row = existing
        ? await trx
            .updateTable('app.loan_schedule')
            .set({ ...values, archived_at: null })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await trx
            .insertInto('app.loan_schedule')
            .values({
              workspace_id: ctx.workspaceId,
              id: newId(),
              loan_account_id: loanAccountId!,
              ...values,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      await this.syncPlanning(trx, ctx, row);
      return this.dto(trx, ctx, row);
    });
  }

  /** Debt payoff reads the account's rate and minimum, so they follow the loan. */
  private async syncPlanning(trx: Trx, ctx: Ctx, r: LoanRow): Promise<void> {
    await trx
      .updateTable('app.bank_account')
      .set({ interest_rate_bps: r.rate_bps, min_payment_minor: paymentOf(r) })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('ledger_account_id', '=', r.loan_account_id)
      .execute();
  }

  async update(ctx: Ctx, id: string, req: UpdateLoanRequest): Promise<LoanDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (BigInt(r.version) !== BigInt(req.version)) {
        throw new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');
      }
      if (req.payingAccountId) {
        const loan = await this.ledger.accountRef(trx, ctx.workspaceId, r.loan_account_id);
        await this.checkPayingAccount(trx, ctx, req.payingAccountId, r.entity_id, loan.currency);
      }
      const paying = req.payingAccountId !== undefined ? req.payingAccountId : r.paying_account_id;
      if ((req.autoRecord ?? r.auto_record) && !paying) {
        throw unprocessable(
          'loan.auto_record',
          'Choose the account it’s paid from to record it automatically',
        );
      }
      // A new rate re-levels what's owed over the time left, unless the lender's figure comes with it.
      let payment: bigint | null | undefined =
        req.paymentAmount === null || req.paymentAmount === undefined
          ? req.paymentAmount
          : BigInt(req.paymentAmount);
      if (req.rateBps !== undefined && req.rateBps !== r.rate_bps && req.paymentAmount === undefined) {
        const { balance, paid } = await this.state(trx, ctx, r);
        const last = paid.reduce((m, p) => (p.number > m ? p.number : m), r.payments_before);
        const left = Math.max(1, r.term_months - last);
        payment =
          balance > 0n
            ? monthlyPayment({ principal: balance, rateBps: req.rateBps, termMonths: left })
            : null;
      }
      const row = await trx
        .updateTable('app.loan_schedule')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.escrowTaxes !== undefined ? { escrow_taxes_minor: req.escrowTaxes } : {}),
          ...(req.escrowInsurance !== undefined ? { escrow_insurance_minor: req.escrowInsurance } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
          ...(req.rateBps !== undefined ? { rate_bps: req.rateBps } : {}),
          ...(payment !== undefined ? { payment_minor: payment } : {}),
          ...(req.payingAccountId !== undefined ? { paying_account_id: req.payingAccountId } : {}),
          ...(req.autoRecord !== undefined ? { auto_record: req.autoRecord } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.syncPlanning(trx, ctx, row);
      return this.dto(trx, ctx, row);
    });
  }

  private async paymentsOf(trx: Trx, ctx: Ctx, loanId: string) {
    return trx
      .selectFrom('app.loan_payment')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('loan_id', '=', loanId)
      .execute();
  }

  /** What's owed, what's been recorded, and what's still to come. */
  private async state(trx: Trx, ctx: Ctx, r: LoanRow) {
    const paid = await this.paymentsOf(trx, ctx, r.id);
    const ledger = (await this.ledger.balances(trx, ctx.workspaceId, [r.loan_account_id])).get(
      r.loan_account_id,
    );
    const owed = -(ledger ?? 0n);
    // An account opened with no balance and nothing paid: the terms are all there is to go on.
    const balance = owed === 0n && paid.length === 0 ? BigInt(r.principal_minor) : owed;
    const rows = projectLoan({
      balance: balance > 0n ? balance : 0n,
      rateBps: r.rate_bps,
      payment: paymentOf(r),
      firstPayment: iso(r.first_payment_date),
      termMonths: r.term_months,
      before: r.payments_before,
      recorded: new Set(paid.map((p) => p.number)),
    });
    return { paid, balance, rows };
  }

  private async dto(trx: Trx, ctx: Ctx, r: LoanRow): Promise<LoanDto> {
    const e = await this.entityOf(trx, ctx, r.entity_id);
    const { paid, balance, rows } = await this.state(trx, ctx, r);
    const payment = paymentOf(r);
    const escrow = escrowOf(r);
    const next = rows[0];
    const byTerms = paid.some((p) => p.interest_minor === null)
      ? amortize(termsOf(r), iso(r.first_payment_date))
      : [];
    const interestOf = (p: (typeof paid)[number]) =>
      p.interest_minor !== null
        ? BigInt(p.interest_minor)
        : (byTerms.find((x) => x.number === p.number)?.interest ?? 0n);
    return {
      id: r.id,
      entityId: r.entity_id,
      propertyId: r.property_id,
      loanAccountId: r.loan_account_id,
      name: r.name,
      startDate: r.start_date ? iso(r.start_date) : null,
      principal: String(r.principal_minor),
      rateBps: r.rate_bps,
      termMonths: r.term_months,
      firstPaymentDate: iso(r.first_payment_date),
      escrowTaxes: String(r.escrow_taxes_minor),
      escrowInsurance: String(r.escrow_insurance_minor),
      payment: String(payment),
      totalPayment: String(payment + escrow),
      scheduledBalance: String(balance > 0n ? balance : 0n),
      paymentsMade: paid.length,
      payingAccountId: r.paying_account_id,
      autoRecord: r.auto_record,
      next: next
        ? {
            number: next.number,
            date: next.date,
            total: String(next.payment + escrow),
            interest: String(next.interest),
            principal: String(next.principal),
            escrow: String(escrow),
          }
        : null,
      payoffDate: rows[rows.length - 1]?.date ?? null,
      interestRemaining: String(rows.reduce((t, x) => t + x.interest, 0n)),
      interestPaid: String(paid.reduce((t, p) => t + interestOf(p), 0n)),
      currency: asCurrencyCode(e.functional_currency),
      version: Number(r.version),
    };
  }

  async schedule(ctx: Ctx, id: string): Promise<AmortizationRowDto[]> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      const { paid, rows } = await this.state(trx, ctx, r);
      const escrow = escrowOf(r);
      const byTerms = amortize(termsOf(r), iso(r.first_payment_date));
      const recorded = paid.map((p): AmortizationRowDto => {
        const terms = byTerms.find((x) => x.number === p.number);
        const interest = p.interest_minor !== null ? BigInt(p.interest_minor) : (terms?.interest ?? 0n);
        const principal = p.principal_minor !== null ? BigInt(p.principal_minor) : (terms?.principal ?? 0n);
        return {
          number: p.number,
          date: terms?.date ?? iso(r.first_payment_date),
          payment: String(interest + principal),
          interest: String(interest),
          principal: String(principal),
          escrow: String(p.escrow_minor !== null ? BigInt(p.escrow_minor) : escrow),
          balance: String(terms?.balance ?? 0n),
          transactionId: p.transaction_id,
        };
      });
      // Walking back from the first unrecorded balance gives each recorded row what really followed it.
      recorded.sort((a, b) => a.number - b.number);
      let after = rows[0] ? rows[0].balance + rows[0].principal : 0n;
      for (let i = recorded.length - 1; i >= 0; i--) {
        recorded[i]!.balance = String(after);
        after += BigInt(recorded[i]!.principal);
      }
      const upcoming = rows.map((row): AmortizationRowDto => ({
        number: row.number,
        date: row.date,
        payment: String(row.payment),
        interest: String(row.interest),
        principal: String(row.principal),
        escrow: String(escrow),
        balance: String(row.balance),
        transactionId: null,
      }));
      return [...recorded, ...upcoming].sort((a, b) => a.number - b.number);
    });
  }

  private async categoryLike(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    names: readonly string[],
    pattern: string,
    what: string,
  ): Promise<string> {
    const c = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('type', '=', 'expense')
      .where('is_category', '=', true)
      .where('archived_at', 'is', null)
      .where((eb) => eb.or([eb('name', 'in', [...names]), eb('name', 'ilike', pattern)]))
      .orderBy(sql`coalesce(array_position(${sql.val([...names])}::text[], name::text), 1000)`)
      .orderBy('name')
      .limit(1)
      .executeTakeFirst();
    if (!c) throw unprocessable('loan.category', `Add a category for ${what} first`);
    return c.id;
  }

  /** Where each part goes. A rental portfolio's are found by Schedule E line; elsewhere by what they're called. */
  private async categoriesFor(trx: Trx, ctx: Ctx, r: LoanRow) {
    const e = await this.entityOf(trx, ctx, r.entity_id);
    if (e.type === 'rental') {
      return {
        interest: () => categoryOnLine(trx, ctx, r.entity_id, SCH_E.MORTGAGE_INTEREST),
        taxes: () => categoryOnLine(trx, ctx, r.entity_id, SCH_E.TAXES),
        insurance: () => categoryOnLine(trx, ctx, r.entity_id, SCH_E.INSURANCE),
      };
    }
    const bank = await trx
      .selectFrom('app.bank_account')
      .select('kind')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('ledger_account_id', '=', r.loan_account_id)
      .executeTakeFirstOrThrow();
    return {
      interest: () =>
        this.categoryLike(
          trx,
          ctx,
          r.entity_id,
          INTEREST_NAMES[bank.kind] ?? INTEREST_NAMES.loan!,
          '%interest%',
          'loan interest',
        ),
      taxes: () =>
        this.categoryLike(trx, ctx, r.entity_id, ['Property tax', 'Taxes'], '%tax%', 'property tax'),
      insurance: () => this.categoryLike(trx, ctx, r.entity_id, ['Insurance'], '%insurance%', 'insurance'),
    };
  }

  /** The parts of one payment, all money out, each tagged to the property if it has one. */
  private async splitsFor(
    trx: Trx,
    ctx: Ctx,
    r: LoanRow,
    interest: bigint,
    principal: bigint,
  ): Promise<SplitSpec[]> {
    const tags = { memberId: null, propertyId: r.property_id };
    const categories = await this.categoriesFor(trx, ctx, r);
    const splits: SplitSpec[] = [];
    if (interest > 0n)
      splits.push({ accountId: await categories.interest(), amount: String(-interest), ...tags });
    if (principal > 0n) splits.push({ accountId: r.loan_account_id, amount: String(-principal), ...tags });
    if (BigInt(r.escrow_taxes_minor) > 0n) {
      splits.push({
        accountId: await categories.taxes(),
        amount: String(-BigInt(r.escrow_taxes_minor)),
        ...tags,
      });
    }
    if (BigInt(r.escrow_insurance_minor) > 0n) {
      splits.push({
        accountId: await categories.insurance(),
        amount: String(-BigInt(r.escrow_insurance_minor)),
        ...tags,
      });
    }
    return splits;
  }

  async recordPayment(ctx: Ctx, id: string, req: LoanPaymentRequest): Promise<LoanDto> {
    return this.db.run(ctx, async (trx) => {
      await this.recordPaymentIn(trx, ctx, id, req, 'manual');
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  async recordPaymentIn(
    trx: Trx,
    ctx: Ctx,
    id: string,
    req: LoanPaymentRequest,
    source: 'auto' | 'manual',
  ): Promise<void> {
    const r = await this.row(trx, ctx, id);
    const e = await this.entityOf(trx, ctx, r.entity_id);
    const { paid, rows } = await this.state(trx, ctx, r);
    if (paid.some((p) => p.number === req.number)) {
      throw unprocessable('loan.already_paid', 'This payment is already recorded');
    }
    const row: AmortizationRow | undefined = rows.find((x) => x.number === req.number);
    if (!row) throw unprocessable('loan.number', 'There is no such payment on this schedule');
    const owedBefore = row.balance + row.principal;
    const escrow = escrowOf(r);
    let principal = row.principal;
    let transactionId: string;
    let depositSpec: unknown = null;
    if ('transactionId' in req) {
      const t = await trx
        .selectFrom('app.transaction')
        .select('spec')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.transactionId)
        .executeTakeFirst();
      if (!t) throw notFound('Transaction');
      const line = -BigInt((t.spec as { amount?: string } | null)?.amount ?? '0');
      if (line !== row.payment + escrow) {
        if (!req.adjustPrincipal) {
          throw unprocessable(
            'loan.amount',
            'The payment must be the amount on the schedule, escrow included',
          );
        }
        principal = line - row.interest - escrow;
        if (principal < 0n) {
          throw unprocessable('loan.amount', 'This doesn’t cover the interest and escrow due');
        }
        if (principal > owedBefore)
          throw unprocessable('loan.amount', 'This is more than is owed on the loan');
      }
      const splits = await this.splitsFor(trx, ctx, r, row.interest, principal);
      const taken = await this.links.takeOver(trx, ctx, req.transactionId, { loanId: id }, splits, {
        sign: -1,
        currency: e.functional_currency,
      });
      transactionId = req.transactionId;
      depositSpec = taken.previous;
    } else {
      principal += BigInt(req.extraPrincipal ?? '0');
      if (principal > owedBefore) throw unprocessable('loan.extra', 'This is more than is owed on the loan');
      const splits = await this.splitsFor(trx, ctx, r, row.interest, principal);
      transactionId = await this.links.create(trx, ctx, {
        entityId: r.entity_id,
        accountId: req.accountId,
        date: req.date,
        amount: -(row.interest + principal + escrow),
        currency: e.functional_currency,
        payee: r.name,
        payeeKey: null,
        description: `${r.name} payment ${req.number}`,
        source: 'loan',
        owner: { loanId: id },
        splits,
      });
    }
    await trx
      .insertInto('app.loan_payment')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: r.entity_id,
        loan_id: id,
        number: req.number,
        transaction_id: transactionId,
        source,
        deposit_spec: depositSpec ? JSON.stringify(depositSpec) : null,
        interest_minor: row.interest,
        principal_minor: principal,
        escrow_minor: escrow,
      })
      .execute();
  }

  async removePayment(ctx: Ctx, id: string, number: number): Promise<LoanDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await trx
        .selectFrom('app.loan_payment')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('loan_id', '=', id)
        .where('number', '=', number)
        .executeTakeFirst();
      if (!p) throw notFound('Payment');
      await trx
        .deleteFrom('app.loan_payment')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.id)
        .execute();
      await this.links.release(trx, ctx, p.transaction_id, p.deposit_spec);
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  /** Payments due in a range and not yet recorded, for the forecast and calendar. */
  async dueBetween(trx: Trx, ctx: Ctx, entityId: string, from: CalendarDate, to: CalendarDate) {
    const loans = await trx
      .selectFrom('app.loan_schedule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('archived_at', 'is', null)
      .execute();
    const out: {
      loanId: string;
      number: number;
      date: CalendarDate;
      amount: bigint;
      name: string;
      payingAccountId: string | null;
    }[] = [];
    for (const r of loans) {
      const { rows } = await this.state(trx, ctx, r);
      const escrow = escrowOf(r);
      for (const row of rows) {
        if (row.date < from) continue;
        if (row.date > to) break;
        out.push({
          loanId: r.id,
          number: row.number,
          date: row.date,
          amount: row.payment + escrow,
          name: r.name,
          payingAccountId: r.paying_account_id,
        });
      }
    }
    return out;
  }

  /**
   * The next payment within 5 days of a bank line for the exact amount links by itself (design 04 §9). With a paying account
   * set, only a line on that account counts.
   */
  async autoMatch(ctx: Ctx): Promise<number> {
    const plan = await this.db.run(ctx, async (trx) => {
      const loans = await trx
        .selectFrom('app.loan_schedule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('archived_at', 'is', null)
        .execute();
      const out: { loanId: string; number: number; transactionId: string }[] = [];
      for (const r of loans) {
        const { rows: upcoming } = await this.state(trx, ctx, r);
        const next = upcoming[0];
        if (!next) continue;
        const total = next.payment + escrowOf(r);
        const { rows } = await sql<{ id: string }>`
          select t.id from app.transaction t
           where t.workspace_id = ${ctx.workspaceId} and t.primary_entity_id = ${r.entity_id}
             and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
             and (t.spec->>'amount')::bigint = ${String(-total)}::bigint
             and abs(t.txn_date - ${next.date}::date) <= 5
             and (${r.paying_account_id}::text is null or t.spec->>'accountId' = ${r.paying_account_id}::text)
             and ${NOT_OWNED}
           limit 2`.execute(trx);
        if (rows.length === 1) out.push({ loanId: r.id, number: next.number, transactionId: rows[0]!.id });
      }
      return out;
    });
    let linked = 0;
    for (const p of plan) {
      await this.db.run(ctx, (trx) =>
        this.recordPaymentIn(
          trx,
          ctx,
          p.loanId,
          { number: p.number, transactionId: p.transactionId },
          'auto',
        ),
      );
      linked++;
    }
    return linked;
  }

  /** Records what's due on the loans set to record themselves, each in its own transaction. Catches up after a gap. */
  async autoRecord(ctx: Ctx): Promise<number> {
    const loans = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.loan_schedule')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('archived_at', 'is', null)
        .where('auto_record', '=', true)
        .where('paying_account_id', 'is not', null)
        .execute(),
    );
    let recorded = 0;
    for (const { id } of loans) {
      for (;;) {
        const done = await this.db.run(ctx, async (trx) => {
          const r = await this.row(trx, ctx, id);
          const { rows } = await this.state(trx, ctx, r);
          const next = rows[0];
          if (!next || compareDates(next.date, await this.today(trx, ctx)) > 0) return false;
          await this.recordPaymentIn(
            trx,
            ctx,
            id,
            { number: next.number, accountId: r.paying_account_id!, date: next.date },
            'auto',
          );
          return true;
        });
        if (!done) break;
        recorded++;
      }
    }
    return recorded;
  }
}
