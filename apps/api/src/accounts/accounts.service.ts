import { Inject, Injectable } from '@nestjs/common';
import { newId, type Trx } from '@montra/db';
import { sql } from 'kysely';
import {
  WORKPLACE_PLANS,
  type PlanType,
  accountProfile,
  asCurrencyCode,
  balanceHistoryDates,
  balanceRangeStart,
  balancesOn,
  buildOpeningBalanceEntry,
  calendarDate,
  convert,
  decimalToString,
  naturalBalance,
  todayIn,
  valueAtCarrying,
  type BalanceRange,
  type CalendarDate,
  type JournalEntryDraft,
} from '@montra/domain';
import type {
  AccountBalanceHistoryDto,
  AccountDto,
  BalanceAdjustmentRequest,
  CategoryDto,
  CreateAccountRequest,
  LedgerAccountDto,
  UpdateAccountRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { FxRatesService } from '../fx/fx.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { notFound, unprocessable } from '../common/errors.js';

type Ctx = { workspaceId: string; userId: string };

@Injectable()
export class AccountsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(FxRatesService) private readonly fx: FxRatesService,
  ) {}

  /** Creates a bank/card/loan/asset account and posts its opening balance (ACC-02, ACC-05). */
  async create(ctx: Ctx, req: CreateAccountRequest): Promise<AccountDto> {
    const id = await this.db.run(ctx, (trx) => this.createIn(trx, ctx, req));
    return (await this.list(ctx)).find((a) => a.id === id)!;
  }

  /**
   * A plan is for an investment, and only a workplace plan takes payslips. The employer must be in the same books, and
   * taking its contributions needs one (ADR-0025).
   */
  private async checkPlan(
    trx: Trx,
    ctx: Ctx,
    kind: string,
    entityId: string,
    p: { planType?: string | null; employerId?: string | null; employerContributions?: boolean },
  ): Promise<void> {
    if ((p.planType ?? null) !== null && kind !== 'investment') {
      throw unprocessable('account.plan_kind', 'Only an investment account has a plan type');
    }
    if (p.employerId) {
      if (!p.planType || !WORKPLACE_PLANS.has(p.planType as PlanType)) {
        throw unprocessable(
          'account.plan_employer',
          'Only a workplace plan, such as a 401(k), takes money from payslips',
        );
      }
      const employer = await trx
        .selectFrom('app.employer')
        .select('entity_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.employerId)
        .executeTakeFirst();
      if (!employer) throw notFound('Employer');
      if (employer.entity_id !== entityId) {
        throw unprocessable('account.plan_employer', 'The employer must be in the same books as the account');
      }
    }
    if (p.employerContributions && !p.employerId) {
      throw unprocessable('account.plan_contributions', 'Choose the employer whose contributions it takes');
    }
  }

  /** The same inside a caller's transaction, for a loan added together with its account. */
  async createIn(trx: Trx, ctx: Ctx, req: CreateAccountRequest): Promise<string> {
    const id = newId();
    {
      const entity = req.entityId
        ? await trx
            .selectFrom('app.entity')
            .select(['id', 'functional_currency'])
            .where('id', '=', req.entityId)
            .executeTakeFirst()
        : await trx
            .selectFrom('app.entity')
            .select(['id', 'functional_currency'])
            .where('workspace_id', '=', ctx.workspaceId)
            .where('type', '=', 'personal')
            .executeTakeFirst();
      if (!entity) throw notFound('Entity');
      const currency = req.currency ?? asCurrencyCode(entity.functional_currency);
      if (req.openingBalance && req.openingBalance.currency !== currency) {
        throw unprocessable('currency.mismatch', 'Opening balance currency must match the account currency');
      }
      const type = accountProfile(req.kind).side;
      await this.checkPlan(trx, ctx, req.kind, entity.id, req);
      await trx
        .insertInto('app.ledger_account')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: entity.id,
          type,
          subtype: req.kind,
          name: req.name,
          currency,
        })
        .execute();
      const natural = BigInt(req.openingBalance?.amount ?? '0');
      const workspace = await trx
        .selectFrom('app.workspace')
        .select('time_zone')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const openingDate = (req.openingDate ?? todayIn(workspace.time_zone)) as CalendarDate;
      await trx
        .insertInto('app.bank_account')
        .values({
          workspace_id: ctx.workspaceId,
          ledger_account_id: id,
          kind: req.kind,
          institution: req.institution ?? null,
          last4: req.last4 ?? null,
          opening_balance_minor: natural,
          opening_date: openingDate,
          default_member_id: req.defaultMemberId ?? null,
          plan_type: req.planType ?? null,
          employer_id: req.employerId ?? null,
          employer_contributions: req.employerContributions ?? false,
          credit_limit_minor: req.creditLimit ?? null,
          interest_rate_bps: req.interestRateBps ?? null,
          min_payment_minor: req.minPayment ?? null,
          ...(req.lowBalance !== undefined ? { low_balance_minor: req.lowBalance } : {}),
        })
        .execute();
      if (natural !== 0n) {
        // ACC-04: a foreign-currency opening balance is valued at the opening date's reference rate.
        const rate =
          currency !== entity.functional_currency
            ? await this.fx.requireRate(trx, currency, entity.functional_currency, openingDate)
            : undefined;
        const ref = await this.ledger.accountRef(trx, ctx.workspaceId, id);
        const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
        // Natural → debit-positive: money held is a debit on assets; money owed is a credit on liabilities.
        const debitPositive = type === 'asset' ? natural : -natural;
        const draft = buildOpeningBalanceEntry(ref, debitPositive, openingDate, resolver, rate);
        await this.ledger.post(trx, ctx, null, [draft]);
      }
    }
    return id;
  }

  async list(
    ctx: Ctx,
    opts: { includeHidden?: boolean; includeArchived?: boolean } = {},
  ): Promise<AccountDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.bank_account as b')
        .innerJoin('app.ledger_account as a', (j) =>
          j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
        )
        .leftJoin('app.account_visibility as v', (j) =>
          j.onRef('v.ledger_account_id', '=', 'a.id').on('v.user_id', '=', ctx.userId),
        )
        .leftJoin('app.loan_schedule as l', (j) =>
          j
            .onRef('l.workspace_id', '=', 'a.workspace_id')
            .onRef('l.loan_account_id', '=', 'a.id')
            .on('l.archived_at', 'is', null),
        )
        .select([
          'l.id as loan_id',
          'a.id',
          'a.entity_id',
          'a.name',
          'a.type',
          'a.currency',
          'a.archived_at',
          'b.kind',
          'b.institution',
          'b.last4',
          'b.default_member_id',
          'b.credit_limit_minor',
          'b.interest_rate_bps',
          'b.min_payment_minor',
          'b.low_balance_minor',
          'b.plan_type',
          'b.employer_id',
          'b.employer_contributions',
          'v.hidden',
        ])
        .where('b.workspace_id', '=', ctx.workspaceId)
        .$if(!opts.includeHidden, (q) =>
          q.where((eb) => eb.or([eb('v.hidden', 'is', null), eb('v.hidden', '=', false)])),
        )
        .$if(!opts.includeArchived && !opts.includeHidden, (q) => q.where('a.archived_at', 'is', null))
        .orderBy('a.created_at')
        .execute();
      const balances = await this.ledger.balances(
        trx,
        ctx.workspaceId,
        rows.map((r) => r.id),
      );
      return rows.map((r) => ({
        id: r.id,
        entityId: r.entity_id,
        name: r.name,
        kind: r.kind,
        type: r.type as 'asset' | 'liability',
        currency: r.currency,
        institution: r.institution,
        last4: r.last4,
        balance: {
          amount: naturalBalance(r.type, balances.get(r.id) ?? 0n).toString(),
          currency: asCurrencyCode(r.currency),
        },
        archived: r.archived_at !== null,
        hidden: r.hidden ?? false,
        defaultMemberId: r.default_member_id,
        loanId: r.loan_id,
        planType: r.plan_type as AccountDto['planType'],
        employerId: r.employer_id,
        employerContributions: r.employer_contributions,
        planning: {
          creditLimit: r.credit_limit_minor !== null ? String(r.credit_limit_minor) : null,
          interestRateBps: r.interest_rate_bps,
          minPayment: r.min_payment_minor !== null ? String(r.min_payment_minor) : null,
          lowBalance: String(r.low_balance_minor),
        },
      }));
    });
  }

  async categories(ctx: Ctx, entityId?: string): Promise<CategoryDto[]> {
    return this.db.run(ctx, async (trx) => {
      let q = trx
        .selectFrom('app.ledger_account as a')
        .leftJoin('app.category_group as g', 'g.id', 'a.category_group_id')
        .select(['a.id', 'a.entity_id', 'a.name', 'a.type', 'a.tax_line_code', 'g.name as group_name'])
        .where('a.workspace_id', '=', ctx.workspaceId)
        .where('a.is_category', '=', true)
        .where('a.archived_at', 'is', null)
        .orderBy('g.sort_order')
        .orderBy('a.sort_order');
      if (entityId) q = q.where('a.entity_id', '=', entityId);
      return (await q.execute()).map((r) => ({
        id: r.id,
        entityId: r.entity_id,
        name: r.name,
        type: r.type as 'income' | 'expense',
        group: r.group_name,
        taxLineCode: r.tax_line_code,
      }));
    });
  }

  register(ctx: Ctx, accountId: string) {
    return this.db.run(ctx, (trx) => this.ledger.register(trx, ctx.workspaceId, accountId));
  }

  /** Rename, re-default, archive (ACC-06, history kept) or hide (per-user preference) an account. */
  /** An account's balance over time. Reads the same restricted-aware rows as every other balance, so it shows what this user may see. */
  async balanceHistory(ctx: Ctx, accountId: string, range: BalanceRange): Promise<AccountBalanceHistoryDto> {
    return this.db.run(ctx, async (trx) => {
      const account = await trx
        .selectFrom('app.bank_account as b')
        .innerJoin('app.ledger_account as a', (j) =>
          j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
        )
        .select(['a.type', 'a.currency'])
        .where('b.workspace_id', '=', ctx.workspaceId)
        .where('b.ledger_account_id', '=', accountId)
        .executeTakeFirst();
      if (!account) throw notFound('Account');
      const workspace = await trx
        .selectFrom('app.workspace')
        .select('time_zone')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const today = todayIn(workspace.time_zone) as CalendarDate;
      const { rows } = await sql<{ d: string; v: string }>`
        select date::text as d, sum(delta_minor)::text as v
          from app.account_balance_daily
         where workspace_id = ${ctx.workspaceId} and ledger_account_id = ${accountId} and date <= ${today}
         group by 1
         order by 1`.execute(trx);
      const changes = rows.map((r) => ({ date: calendarDate(r.d), delta: BigInt(r.v) }));
      const dates = changes.length
        ? balanceHistoryDates(balanceRangeStart(range, today, changes[0]!.date), today)
        : [];
      return {
        accountId,
        currency: account.currency,
        range,
        points: balancesOn(account.type as 'asset' | 'liability', changes, dates).map((p) => ({
          date: p.date,
          balance: String(p.balance),
        })),
      };
    });
  }

  async update(ctx: Ctx, accountId: string, req: UpdateAccountRequest): Promise<AccountDto> {
    await this.db.run(ctx, async (trx) => {
      await this.ledger.accountRef(trx, ctx.workspaceId, accountId);
      if (req.interestRateBps !== undefined || req.minPayment !== undefined) {
        const tracked = await trx
          .selectFrom('app.loan_schedule')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('loan_account_id', '=', accountId)
          .where('archived_at', 'is', null)
          .executeTakeFirst();
        if (tracked) {
          throw unprocessable(
            'loan.tracked',
            'This loan’s payments are tracked: change its rate on the account page',
          );
        }
      }
      if (req.name !== undefined || req.archived !== undefined) {
        await trx
          .updateTable('app.ledger_account')
          .set({
            ...(req.name !== undefined ? { name: req.name } : {}),
            ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
          })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', accountId)
          .execute();
      }
      const bank = {
        ...(req.institution !== undefined ? { institution: req.institution } : {}),
        ...(req.last4 !== undefined ? { last4: req.last4 } : {}),
        ...(req.defaultMemberId !== undefined ? { default_member_id: req.defaultMemberId } : {}),
        ...(req.creditLimit !== undefined ? { credit_limit_minor: req.creditLimit } : {}),
        ...(req.interestRateBps !== undefined ? { interest_rate_bps: req.interestRateBps } : {}),
        ...(req.minPayment !== undefined ? { min_payment_minor: req.minPayment } : {}),
        ...(req.lowBalance !== undefined ? { low_balance_minor: req.lowBalance } : {}),
        ...(req.planType !== undefined ? { plan_type: req.planType } : {}),
        ...(req.employerId !== undefined ? { employer_id: req.employerId } : {}),
        ...(req.employerContributions !== undefined
          ? { employer_contributions: req.employerContributions }
          : {}),
      };
      if (
        req.planType !== undefined ||
        req.employerId !== undefined ||
        req.employerContributions !== undefined
      ) {
        const now = await trx
          .selectFrom('app.bank_account as b')
          .innerJoin('app.ledger_account as a', (j) =>
            j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
          )
          .select(['b.kind', 'b.plan_type', 'b.employer_id', 'b.employer_contributions', 'a.entity_id'])
          .where('b.workspace_id', '=', ctx.workspaceId)
          .where('b.ledger_account_id', '=', accountId)
          .executeTakeFirstOrThrow();
        await this.checkPlan(trx, ctx, now.kind, now.entity_id, {
          planType: req.planType !== undefined ? req.planType : now.plan_type,
          employerId: req.employerId !== undefined ? req.employerId : now.employer_id,
          employerContributions:
            req.employerContributions !== undefined ? req.employerContributions : now.employer_contributions,
        });
      }
      if (Object.keys(bank).length) {
        await trx
          .updateTable('app.bank_account')
          .set(bank)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('ledger_account_id', '=', accountId)
          .execute();
      }
      if (req.hidden !== undefined) {
        await trx
          .insertInto('app.account_visibility')
          .values({
            workspace_id: ctx.workspaceId,
            user_id: ctx.userId,
            ledger_account_id: accountId,
            hidden: req.hidden,
          })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'user_id', 'ledger_account_id']).doUpdateSet({ hidden: req.hidden! }),
          )
          .execute();
      }
    });
    const account = (await this.list(ctx, { includeHidden: true })).find((a) => a.id === accountId);
    if (!account) throw notFound('Account');
    return account;
  }

  /**
   * Sets the account's natural balance on `date` to the given amount by posting the difference against
   * opening-balance equity (ACC-05). The audit trail records the entry and the note.
   */
  async adjustBalance(
    ctx: Ctx,
    accountId: string,
    req: BalanceAdjustmentRequest,
  ): Promise<{ adjustment: string; entryId: string | null }> {
    return this.db.run(ctx, async (trx) => {
      const account = await this.ledger.accountRef(trx, ctx.workspaceId, accountId);
      if (account.type !== 'asset' && account.type !== 'liability') {
        throw unprocessable(
          'account.not_a_bank_account',
          'Only bank, card, loan and asset accounts have balances to adjust',
        );
      }
      if (req.balance.currency !== account.currency)
        throw unprocessable('currency.mismatch', `Balance must be in ${account.currency}`);
      const { rows } = await sql<{ total: bigint | null; functional: bigint | null }>`
        select sum(amount_minor)::bigint as total, sum(functional_amount_minor)::bigint as functional
          from app.posting
         where workspace_id = ${ctx.workspaceId} and ledger_account_id = ${accountId} and entry_date <= ${req.date}`.execute(
        trx,
      );
      const current = naturalBalance(account.type, BigInt(rows[0]?.total ?? 0n));
      const deltaNatural = BigInt(req.balance.amount) - current;
      if (deltaNatural === 0n) return { adjustment: '0', entryId: null };
      const debit = account.type === 'asset' ? deltaNatural : -deltaNatural;
      const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
      const equity = resolver.systemAccount(account.entityId, 'opening_balance_equity');
      const entity = resolver.entity(account.entityId);
      // A foreign-currency account (ADR-0010): an increase at the day's rate, a decrease at carrying value.
      let functional = debit;
      let fxRate: string | null = null;
      if (account.currency !== entity.functionalCurrency) {
        const rate = await this.fx.requireRate(trx, account.currency, entity.functionalCurrency, req.date);
        const atRate = convert(
          { amount: debit, currency: account.currency },
          entity.functionalCurrency,
          rate,
        ).amount;
        functional = valueAtCarrying(
          debit,
          { foreign: BigInt(rows[0]?.total ?? 0n), functional: BigInt(rows[0]?.functional ?? 0n) },
          atRate,
        );
        fxRate = decimalToString(rate);
      }
      const draft: JournalEntryDraft = {
        entityId: account.entityId,
        functionalCurrency: entity.functionalCurrency,
        entryDate: req.date,
        kind: 'adjustment',
        description: `Balance adjustment: ${req.note}`,
        postings: [
          {
            lineNo: 1,
            accountId,
            accountEntityId: account.entityId,
            currency: account.currency,
            amount: debit,
            functionalAmount: functional,
            fxRate,
          },
          {
            lineNo: 2,
            accountId: equity.id,
            accountEntityId: account.entityId,
            currency: equity.currency,
            amount: -functional,
            functionalAmount: -functional,
            fxRate: null,
          },
        ],
      };
      const [entryId] = await this.ledger.post(trx, ctx, null, [draft]);
      return { adjustment: deltaNatural.toString(), entryId: entryId ?? null };
    });
  }

  async ledgerAccounts(ctx: Ctx, entityId?: string): Promise<LedgerAccountDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.ledger_account')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(Boolean(entityId), (q) => q.where('entity_id', '=', entityId!))
        .orderBy('entity_id')
        .orderBy('type')
        .orderBy('sort_order')
        .orderBy('name')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        entityId: r.entity_id,
        type: r.type,
        subtype: r.subtype,
        name: r.name,
        currency: r.currency,
        isCategory: r.is_category,
        systemRole: r.system_role,
        counterpartyEntityId: r.counterparty_entity_id,
        taxLineCode: r.tax_line_code,
        archived: r.archived_at !== null,
      }));
    });
  }
}
