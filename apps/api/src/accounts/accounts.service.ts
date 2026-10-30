import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@montra/db';
import { sql } from 'kysely';
import {
  asCurrencyCode,
  buildOpeningBalanceEntry,
  naturalBalance,
  todayIn,
  type CalendarDate,
  type JournalEntryDraft,
} from '@montra/domain';
import type {
  AccountDto,
  BalanceAdjustmentRequest,
  BankAccountKind,
  CategoryDto,
  CreateAccountRequest,
  UpdateAccountRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { notFound, unprocessable } from '../common/errors.js';

const LIABILITY_KINDS: ReadonlySet<BankAccountKind> = new Set([
  'credit_card',
  'loan',
  'mortgage',
  'line_of_credit',
  'liability',
]);

type Ctx = { workspaceId: string; userId: string };

@Injectable()
export class AccountsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /** Creates a bank/card/loan/asset account and posts its opening balance (ACC-02, ACC-05). */
  async create(ctx: Ctx, req: CreateAccountRequest): Promise<AccountDto> {
    const id = newId();
    await this.db.run(ctx, async (trx) => {
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
      const type = LIABILITY_KINDS.has(req.kind) ? 'liability' : 'asset';
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
        })
        .execute();
      if (natural !== 0n) {
        if (currency !== entity.functional_currency) {
          throw unprocessable(
            'fx.rate_required',
            'Foreign-currency opening balances arrive with FX support (Phase 5)',
          );
        }
        const ref = await this.ledger.accountRef(trx, ctx.workspaceId, id);
        const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
        // Natural → debit-positive: money held is a debit on assets; money owed is a credit on liabilities.
        const debitPositive = type === 'asset' ? natural : -natural;
        const draft = buildOpeningBalanceEntry(ref, debitPositive, openingDate, resolver);
        await this.ledger.post(trx, ctx, null, [draft]);
      }
    });
    return (await this.list(ctx)).find((a) => a.id === id)!;
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
        .select([
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
  async update(ctx: Ctx, accountId: string, req: UpdateAccountRequest): Promise<AccountDto> {
    await this.db.run(ctx, async (trx) => {
      await this.ledger.accountRef(trx, ctx.workspaceId, accountId);
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
      if (req.institution !== undefined || req.last4 !== undefined || req.defaultMemberId !== undefined) {
        await trx
          .updateTable('app.bank_account')
          .set({
            ...(req.institution !== undefined ? { institution: req.institution } : {}),
            ...(req.last4 !== undefined ? { last4: req.last4 } : {}),
            ...(req.defaultMemberId !== undefined ? { default_member_id: req.defaultMemberId } : {}),
          })
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
      const { rows } = await sql<{ total: bigint | null }>`
        select sum(amount_minor)::bigint as total from app.posting
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
            functionalAmount: debit,
            fxRate: null,
          },
          {
            lineNo: 2,
            accountId: equity.id,
            accountEntityId: account.entityId,
            currency: equity.currency,
            amount: -debit,
            functionalAmount: -debit,
            fxRate: null,
          },
        ],
      };
      const [entryId] = await this.ledger.post(trx, ctx, null, [draft]);
      return { adjustment: deltaNatural.toString(), entryId: entryId ?? null };
    });
  }
}
