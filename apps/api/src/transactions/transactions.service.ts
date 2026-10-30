import { Inject, Injectable } from '@nestjs/common';
import { newId, type Trx } from '@montra/db';
import {
  buildTransactionEntries,
  buildTransferEntries,
  isBalanceSheet,
  type JournalEntryDraft,
  type SplitInput,
} from '@montra/domain';
import type { CreateTransactionRequest, CreateTransferRequest, TransactionDto } from '@montra/schemas';
import { Db } from '../db/database.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { notFound, unprocessable } from '../common/errors.js';

type Ctx = { workspaceId: string; userId: string };

@Injectable()
export class TransactionsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /** Income, expense or split transaction (TXN-01..03, DE-05). Uncategorized items go to the review queue. */
  async create(ctx: Ctx, req: CreateTransactionRequest): Promise<TransactionDto> {
    const id = newId();
    await this.db.run(ctx, async (trx) => {
      const account = await this.ledger.accountRef(trx, ctx.workspaceId, req.accountId);
      if (!isBalanceSheet(account.type)) {
        throw unprocessable(
          'account.not_a_bank_account',
          'Transactions are recorded against a bank, card or asset account',
        );
      }
      if (req.amount.currency !== account.currency) {
        throw unprocessable('currency.mismatch', `Amount currency must be ${account.currency}`);
      }
      const amount = BigInt(req.amount.amount);
      const detail = await trx
        .selectFrom('app.bank_account')
        .select('default_member_id')
        .where('ledger_account_id', '=', account.id)
        .executeTakeFirst();
      const defaultMember = req.memberId === undefined ? (detail?.default_member_id ?? null) : req.memberId;

      let reviewState: 'reviewed' | 'needs_review' = 'reviewed';
      let splitSpecs: { accountId: string; amount: bigint; memberId: string | null; memo?: string }[];
      if (req.splits) {
        splitSpecs = req.splits.map((s) => {
          if (s.amount.currency !== account.currency) {
            throw unprocessable('currency.mismatch', `Split currency must be ${account.currency}`);
          }
          return {
            accountId: s.accountId,
            amount: BigInt(s.amount.amount),
            memberId: s.memberId === undefined ? defaultMember : s.memberId,
            memo: s.memo,
          };
        });
      } else if (req.categoryId) {
        splitSpecs = [{ accountId: req.categoryId, amount, memberId: defaultMember }];
      } else {
        // No category yet: post to the uncategorized system account and flag for review (design 04 §2).
        const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
        const role = amount < 0n ? 'uncategorized_expense' : 'uncategorized_income';
        splitSpecs = [
          { accountId: resolver.systemAccount(account.entityId, role).id, amount, memberId: defaultMember },
        ];
        reviewState = 'needs_review';
      }

      const splits: SplitInput[] = [];
      for (const s of splitSpecs) {
        const ref = await this.ledger.accountRef(trx, ctx.workspaceId, s.accountId);
        if (ref.id === account.id)
          throw unprocessable('split.same_account', 'A split cannot target the paying account');
        splits.push({ account: ref, amount: s.amount, memberId: s.memberId, memo: s.memo ?? null });
      }
      const resolver = await this.ledger.resolver(
        trx,
        ctx.workspaceId,
        splits.map((s) => [account.entityId, s.account.entityId] as [string, string]),
      );
      const drafts = buildTransactionEntries(
        {
          date: req.date,
          description: req.description ?? req.payee ?? '',
          account,
          amount,
          splits,
          accountTags: { memberId: defaultMember },
        },
        resolver,
      );
      await this.insertTransaction(
        trx,
        ctx,
        id,
        account.entityId,
        req.date,
        req.payee,
        req.description,
        reviewState,
      );
      await this.ledger.post(trx, ctx, id, drafts);
      if (req.tags?.length) await this.tag(trx, ctx, id, req.tags);
    });
    return (await this.get(ctx, id))!;
  }

  /** Transfer between accounts: one entry per entity, never income or expense (TXN-04, DE-03). */
  async transfer(ctx: Ctx, req: CreateTransferRequest): Promise<TransactionDto> {
    const id = newId();
    await this.db.run(ctx, async (trx) => {
      const from = await this.ledger.accountRef(trx, ctx.workspaceId, req.fromAccountId);
      const to = await this.ledger.accountRef(trx, ctx.workspaceId, req.toAccountId);
      if (!isBalanceSheet(from.type) || !isBalanceSheet(to.type)) {
        throw unprocessable(
          'account.not_a_bank_account',
          'Transfers move money between bank, card or asset accounts',
        );
      }
      if (req.amount.currency !== from.currency)
        throw unprocessable('currency.mismatch', `Amount currency must be ${from.currency}`);
      if (from.currency !== to.currency) {
        throw unprocessable(
          'fx.rate_required',
          'Transfers between currencies arrive with FX support (Phase 5)',
        );
      }
      const amountOut = BigInt(req.amount.amount);
      if (amountOut <= 0n) throw unprocessable('amount.not_positive', 'Transfer amount must be positive');
      const resolver = await this.ledger.resolver(trx, ctx.workspaceId, [[from.entityId, to.entityId]]);
      const drafts: JournalEntryDraft[] = buildTransferEntries(
        { date: req.date, description: req.description ?? 'Transfer', from, to, amountOut },
        resolver,
      );
      await this.insertTransaction(
        trx,
        ctx,
        id,
        from.entityId,
        req.date,
        undefined,
        req.description ?? 'Transfer',
        'reviewed',
      );
      await this.ledger.post(trx, ctx, id, drafts);
    });
    return (await this.get(ctx, id))!;
  }

  async list(ctx: Ctx, opts: { from?: string; to?: string; limit: number }): Promise<TransactionDto[]> {
    const ids = await this.db.run(ctx, async (trx) => {
      let q = trx
        .selectFrom('app.transaction')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('deleted_at', 'is', null)
        .orderBy('txn_date', 'desc')
        .orderBy('id', 'desc')
        .limit(opts.limit);
      if (opts.from) q = q.where('txn_date', '>=', opts.from);
      if (opts.to) q = q.where('txn_date', '<=', opts.to);
      return q.execute();
    });
    return this.db.run(ctx, (trx) =>
      this.load(
        trx,
        ctx,
        ids.map((r) => r.id),
      ),
    );
  }

  async get(ctx: Ctx, id: string): Promise<TransactionDto | null> {
    const [t] = await this.db.run(ctx, (trx) => this.load(trx, ctx, [id]));
    return t ?? null;
  }

  async getOrThrow(ctx: Ctx, id: string): Promise<TransactionDto> {
    const t = await this.get(ctx, id);
    if (!t) throw notFound('Transaction');
    return t;
  }

  private async insertTransaction(
    trx: Trx,
    ctx: Ctx,
    id: string,
    entityId: string,
    date: string,
    payee: string | undefined,
    description: string | undefined,
    reviewState: 'reviewed' | 'needs_review',
  ): Promise<void> {
    await trx
      .insertInto('app.transaction')
      .values({
        workspace_id: ctx.workspaceId,
        id,
        primary_entity_id: entityId,
        txn_date: date,
        payee_raw: payee ?? null,
        description: description ?? '',
        review_state: reviewState,
        source: 'manual',
        created_by: ctx.userId,
      })
      .execute();
  }

  private async tag(trx: Trx, ctx: Ctx, transactionId: string, names: string[]): Promise<void> {
    for (const name of new Set(names)) {
      let tag = await trx
        .selectFrom('app.tag')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where((eb) => eb(eb.fn('lower', ['name']), '=', name.toLowerCase()))
        .executeTakeFirst();
      if (!tag) {
        tag = { id: newId() };
        await trx.insertInto('app.tag').values({ workspace_id: ctx.workspaceId, id: tag.id, name }).execute();
      }
      await trx
        .insertInto('app.transaction_tag')
        .values({ workspace_id: ctx.workspaceId, transaction_id: transactionId, tag_id: tag.id })
        .execute();
    }
  }

  private async load(trx: Trx, ctx: Ctx, ids: string[]): Promise<TransactionDto[]> {
    if (ids.length === 0) return [];
    const txns = await trx
      .selectFrom('app.transaction')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', ids)
      .execute();
    // RLS already hides entries of entities the caller can't read.
    const entries = await trx
      .selectFrom('app.journal_entry')
      .select(['id', 'entity_id', 'transaction_id', 'entry_date', 'kind', 'description'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('transaction_id', 'in', ids)
      .orderBy('posted_at')
      .orderBy('id')
      .execute();
    const postings = entries.length
      ? await trx
          .selectFrom('app.posting as p')
          .innerJoin('app.ledger_account as a', 'a.id', 'p.ledger_account_id')
          .select([
            'p.journal_entry_id',
            'p.line_no',
            'p.ledger_account_id',
            'a.name',
            'p.amount_minor',
            'p.currency',
            'p.member_id',
            'p.memo',
          ])
          .where('p.workspace_id', '=', ctx.workspaceId)
          .where(
            'p.journal_entry_id',
            'in',
            entries.map((e) => e.id),
          )
          .orderBy('p.line_no')
          .execute()
      : [];
    const byOrder = new Map(ids.map((id, i) => [id, i]));
    return txns
      .sort((a, b) => byOrder.get(a.id)! - byOrder.get(b.id)!)
      .map((t) => ({
        id: t.id,
        date: t.txn_date,
        payee: t.payee_raw,
        description: t.description,
        status: t.status,
        reviewState: t.review_state,
        source: t.source,
        version: t.version.toString(),
        entries: entries
          .filter((e) => e.transaction_id === t.id)
          .map((e) => ({
            id: e.id,
            entityId: e.entity_id,
            date: e.entry_date,
            kind: e.kind,
            description: e.description,
            postings: postings
              .filter((p) => p.journal_entry_id === e.id)
              .map((p) => ({
                lineNo: p.line_no,
                accountId: p.ledger_account_id,
                accountName: p.name,
                debit: p.amount_minor > 0n ? p.amount_minor.toString() : null,
                credit: p.amount_minor < 0n ? (-p.amount_minor).toString() : null,
                currency: p.currency,
                memberId: p.member_id,
                memo: p.memo,
              })),
          })),
      }));
  }
}
