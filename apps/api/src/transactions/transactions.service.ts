import { Inject, Injectable } from '@nestjs/common';
import { newId, type Trx } from '@montra/db';
import { calendarDate } from '@montra/domain';
import type {
  BulkEditRequest,
  BulkEditResult,
  ConfirmOccurrenceRequest,
  CreateTransactionRequest,
  CreateTransferRequest,
  TransactionDto,
  UpdateTransactionRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { TransactionPoster, type SplitSpec, type TransactionSpec } from './poster.js';

type Ctx = { workspaceId: string; userId: string };

export class VersionMismatchError extends AppError {
  constructor() {
    super(412, 'version.mismatch', 'The transaction changed since you loaded it. Reload and try again.');
  }
}

@Injectable()
export class TransactionsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  /** Income, expense or split transaction (TXN-01..03, DE-05). Uncategorized items go to the review queue. */
  async create(ctx: Ctx, req: CreateTransactionRequest): Promise<TransactionDto> {
    const id = newId();
    await this.db.run(ctx, async (trx) => {
      const spec = await this.standardSpec(trx, ctx, {
        accountId: req.accountId,
        amount: req.amount,
        description: req.description ?? req.payee ?? '',
        categoryId: req.categoryId,
        splits: req.splits,
        memberId: req.memberId,
      });
      const built = await this.poster.build(trx, ctx, spec, req.date);
      await trx
        .insertInto('app.transaction')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          primary_entity_id: built.primaryEntityId,
          txn_date: req.date,
          payee_raw: req.payee ?? null,
          description: req.description ?? '',
          memo_enc: await this.crypto.encrypt(trx, ctx.workspaceId, 'transaction.memo', req.memo),
          review_state: spec.type === 'standard' && spec.uncategorized ? 'needs_review' : 'reviewed',
          source: 'manual',
          spec: JSON.stringify(spec),
          posted_at: new Date(),
          created_by: ctx.userId,
        })
        .execute();
      await this.poster.repost(trx, ctx, id, built.drafts);
      if (req.tags?.length) await this.setTags(trx, ctx, id, req.tags);
    });
    return this.getOrThrow(ctx, id);
  }

  /** Transfer between accounts: one entry per entity, never income or expense (TXN-04, DE-03). */
  async transfer(ctx: Ctx, req: CreateTransferRequest): Promise<TransactionDto> {
    const id = newId();
    await this.db.run(ctx, async (trx) => {
      const spec: TransactionSpec = {
        type: 'transfer',
        fromAccountId: req.fromAccountId,
        toAccountId: req.toAccountId,
        amount: req.amount.amount,
        currency: req.amount.currency,
        description: req.description ?? 'Transfer',
      };
      const built = await this.poster.build(trx, ctx, spec, req.date);
      await trx
        .insertInto('app.transaction')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          primary_entity_id: built.primaryEntityId,
          txn_date: req.date,
          description: spec.description,
          source: 'manual',
          spec: JSON.stringify(spec),
          posted_at: new Date(),
          created_by: ctx.userId,
        })
        .execute();
      await this.poster.repost(trx, ctx, id, built.drafts);
    });
    return this.getOrThrow(ctx, id);
  }

  /**
   * Edits a transaction (DE-10). Ledger fields re-run the posting builder; the poster decides between an
   * in-place rewrite, a reclassification on the original date, or reversal into the first open period.
   */
  async update(
    ctx: Ctx,
    id: string,
    req: UpdateTransactionRequest,
    ifMatch?: string,
  ): Promise<TransactionDto> {
    await this.db.run(ctx, async (trx) => {
      const row = await this.lockRow(trx, ctx, id, ifMatch);
      if (row.status === 'void')
        throw unprocessable('transaction.void', 'A voided transaction cannot be edited');
      const spec = row.spec as TransactionSpec | null;
      if (!spec) throw unprocessable('transaction.not_editable', 'This transaction has no editable input');
      const date = req.date ?? calendarDate(row.txn_date);
      const next = await this.mergeSpec(trx, ctx, spec, req);
      const ledgerChanged = JSON.stringify(next) !== JSON.stringify(spec) || date !== row.txn_date;
      if (ledgerChanged && row.status !== 'scheduled') {
        const built = await this.poster.build(trx, ctx, next, date);
        await this.poster.repost(trx, ctx, id, built.drafts);
      }
      const reviewState =
        req.reviewState ??
        (next.type === 'standard' && !next.uncategorized && row.review_state === 'needs_review'
          ? 'reviewed'
          : row.review_state);
      await trx
        .updateTable('app.transaction')
        .set({
          txn_date: date,
          spec: JSON.stringify(next),
          payee_raw: req.payee === undefined ? row.payee_raw : req.payee,
          description: req.description ?? row.description,
          review_state: reviewState,
          ...(req.memo !== undefined
            ? { memo_enc: await this.crypto.encrypt(trx, ctx.workspaceId, 'transaction.memo', req.memo) }
            : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      if (req.tags) await this.setTags(trx, ctx, id, req.tags);
    });
    return this.getOrThrow(ctx, id);
  }

  /** Void and move to trash (BAK-06). Entries are removed, or reversed when their period is closed. */
  async remove(ctx: Ctx, id: string, ifMatch?: string): Promise<{ outcome: 'removed' | 'reversed' }> {
    return this.db.run(ctx, async (trx) => {
      const row = await this.lockRow(trx, ctx, id, ifMatch);
      if (row.status === 'void') return { outcome: 'removed' as const };
      const outcome = await this.poster.unpost(trx, ctx, id);
      await trx
        .updateTable('app.transaction')
        .set({ status: 'void', deleted_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return { outcome };
    });
  }

  /** Restores a trashed transaction by re-posting its spec, if its entries were removed (not reversed). */
  async restore(ctx: Ctx, id: string): Promise<TransactionDto> {
    await this.db.run(ctx, async (trx) => {
      const row = await this.lockRow(trx, ctx, id);
      if (row.status !== 'void' || !row.deleted_at)
        throw unprocessable('transaction.not_in_trash', 'Not in the trash');
      if (await this.poster.hasEntries(trx, ctx, id)) {
        throw unprocessable(
          'transaction.reversed',
          'This transaction was reversed in a closed period; record it again instead',
        );
      }
      const built = await this.poster.build(
        trx,
        ctx,
        row.spec as TransactionSpec,
        calendarDate(row.txn_date),
      );
      await this.poster.repost(trx, ctx, id, built.drafts);
      await trx
        .updateTable('app.transaction')
        .set({ status: 'posted', deleted_at: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
    return this.getOrThrow(ctx, id);
  }

  /** Bulk edit (TXN-10, UP-08). Each transaction goes through the same edit path; failures are reported. */
  async bulk(ctx: Ctx, req: BulkEditRequest): Promise<BulkEditResult> {
    const result: BulkEditResult = { updated: [], skipped: [] };
    for (const id of new Set(req.ids)) {
      try {
        const patch = await this.db.run(ctx, (trx) => this.bulkPatch(trx, ctx, id, req.set));
        if (!patch) {
          result.skipped.push({ id, reason: 'Split across several categories; edit it individually' });
          continue;
        }
        await this.update(ctx, id, patch);
        result.updated.push(id);
      } catch (e) {
        result.skipped.push({ id, reason: e instanceof AppError ? e.code : 'error' });
      }
    }
    return result;
  }

  /** Confirms a scheduled occurrence (TXN-05): posts it, optionally with the actual amount or date. */
  async confirm(ctx: Ctx, id: string, req: ConfirmOccurrenceRequest): Promise<TransactionDto> {
    await this.db.run(ctx, async (trx) => {
      const row = await this.lockRow(trx, ctx, id);
      if (row.status !== 'scheduled')
        throw unprocessable('transaction.not_scheduled', 'Only scheduled transactions can be confirmed');
      let spec = row.spec as TransactionSpec;
      if (req.amount) spec = await this.mergeSpec(trx, ctx, spec, { amount: req.amount });
      const date = req.date ?? calendarDate(row.txn_date);
      const built = await this.poster.build(trx, ctx, spec, date);
      await this.poster.repost(trx, ctx, id, built.drafts);
      await trx
        .updateTable('app.transaction')
        .set({ status: 'posted', txn_date: date, spec: JSON.stringify(spec), posted_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
    return this.getOrThrow(ctx, id);
  }

  async list(
    ctx: Ctx,
    opts: {
      from?: string;
      to?: string;
      limit: number;
      status?: string;
      reviewState?: string;
      accountId?: string;
    },
  ): Promise<TransactionDto[]> {
    return this.db.run(ctx, async (trx) => {
      let q = trx
        .selectFrom('app.transaction as t')
        .select('t.id')
        .where('t.workspace_id', '=', ctx.workspaceId)
        .where('t.deleted_at', 'is', null)
        .orderBy('t.txn_date', 'desc')
        .orderBy('t.id', 'desc')
        .limit(opts.limit);
      if (opts.from) q = q.where('t.txn_date', '>=', opts.from);
      if (opts.to) q = q.where('t.txn_date', '<=', opts.to);
      if (opts.status) q = q.where('t.status', '=', opts.status as 'posted');
      if (opts.reviewState) q = q.where('t.review_state', '=', opts.reviewState as 'needs_review');
      if (opts.accountId) {
        const accountId = opts.accountId;
        q = q.where((eb) =>
          eb.exists(
            eb
              .selectFrom('app.posting as p')
              .innerJoin('app.journal_entry as je', (j) =>
                j.onRef('je.workspace_id', '=', 'p.workspace_id').onRef('je.id', '=', 'p.journal_entry_id'),
              )
              .select('p.id')
              .whereRef('je.transaction_id', '=', 't.id')
              .where('p.ledger_account_id', '=', accountId),
          ),
        );
      }
      const ids = await q.execute();
      return this.load(
        trx,
        ctx,
        ids.map((r) => r.id),
      );
    });
  }

  async getOrThrow(ctx: Ctx, id: string): Promise<TransactionDto> {
    const [t] = await this.db.run(ctx, (trx) => this.load(trx, ctx, [id]));
    if (!t) throw notFound('Transaction');
    return t;
  }

  // -------------------------------------------------------------------------------------------------------

  /** Builds a standard spec from user input: category, explicit splits, or the uncategorized account. */
  async standardSpec(
    trx: Trx,
    ctx: Ctx,
    input: {
      accountId: string;
      amount: { amount: string; currency: string };
      description: string;
      categoryId?: string;
      splits?: {
        accountId: string;
        amount: { amount: string; currency: string };
        memberId?: string | null;
        memo?: string;
      }[];
      memberId?: string | null;
    },
  ): Promise<TransactionSpec> {
    const detail = await trx
      .selectFrom('app.bank_account')
      .select('default_member_id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('ledger_account_id', '=', input.accountId)
      .executeTakeFirst();
    // FAM-04: the account's default member applies unless the caller says otherwise.
    const memberId = input.memberId === undefined ? (detail?.default_member_id ?? null) : input.memberId;
    let splits: SplitSpec[];
    let uncategorized = false;
    if (input.splits) {
      splits = input.splits.map((s) => {
        if (s.amount.currency !== input.amount.currency) {
          throw unprocessable('currency.mismatch', `Split currency must be ${input.amount.currency}`);
        }
        return {
          accountId: s.accountId,
          amount: s.amount.amount,
          memberId: s.memberId === undefined ? memberId : s.memberId,
          memo: s.memo ?? null,
        };
      });
    } else if (input.categoryId) {
      splits = [{ accountId: input.categoryId, amount: input.amount.amount, memberId }];
    } else {
      splits = [
        {
          accountId: await this.poster.uncategorizedAccount(
            trx,
            ctx,
            input.accountId,
            BigInt(input.amount.amount),
          ),
          amount: input.amount.amount,
          memberId,
        },
      ];
      uncategorized = true;
    }
    return {
      type: 'standard',
      accountId: input.accountId,
      amount: input.amount.amount,
      currency: input.amount.currency,
      description: input.description,
      memberId,
      uncategorized,
      splits,
    };
  }

  private async mergeSpec(
    trx: Trx,
    ctx: Ctx,
    spec: TransactionSpec,
    req: UpdateTransactionRequest,
  ): Promise<TransactionSpec> {
    if (spec.type === 'transfer') {
      if (req.categoryId || req.splits) {
        throw unprocessable(
          'transaction.is_transfer',
          'A transfer has no category; delete it and record an expense instead',
        );
      }
      return {
        ...spec,
        amount: req.amount?.amount ?? spec.amount,
        currency: req.amount?.currency ?? spec.currency,
        description: req.description ?? spec.description,
      };
    }
    const amount = req.amount ?? { amount: spec.amount, currency: spec.currency };
    const accountId = req.accountId ?? spec.accountId;
    const memberId = req.memberId === undefined ? spec.memberId : req.memberId;
    const description = req.description ?? spec.description;
    if (req.splits || req.categoryId) {
      return this.standardSpec(trx, ctx, {
        accountId,
        amount,
        description,
        categoryId: req.categoryId,
        splits: req.splits,
        memberId,
      });
    }
    // Keep the existing categorization; scale a single split to a new amount, keep multi-split amounts.
    let splits = spec.splits.map((s) => (req.memberId !== undefined ? { ...s, memberId } : s));
    if (req.amount && req.amount.amount !== spec.amount) {
      if (splits.length !== 1) {
        throw unprocessable(
          'splits.required',
          'Changing the amount of a split transaction requires new splits',
        );
      }
      splits = [{ ...splits[0]!, amount: amount.amount }];
      if (spec.uncategorized && BigInt(amount.amount) < 0n !== BigInt(spec.amount) < 0n) {
        splits = [
          {
            ...splits[0]!,
            accountId: await this.poster.uncategorizedAccount(trx, ctx, accountId, BigInt(amount.amount)),
          },
        ];
      }
    }
    return {
      ...spec,
      accountId,
      amount: amount.amount,
      currency: amount.currency,
      description,
      memberId,
      splits,
    };
  }

  private async bulkPatch(
    trx: Trx,
    ctx: Ctx,
    id: string,
    set: BulkEditRequest['set'],
  ): Promise<UpdateTransactionRequest | null> {
    const row = await trx
      .selectFrom('app.transaction')
      .select(['spec'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Transaction');
    const spec = row.spec as TransactionSpec | null;
    const patch: UpdateTransactionRequest = {};
    if (set.reviewState) patch.reviewState = set.reviewState;
    if (set.memberId !== undefined) patch.memberId = set.memberId;
    if (set.addTags || set.removeTags) {
      const current = await this.tagNames(trx, ctx, id);
      const remove = new Set((set.removeTags ?? []).map((t) => t.toLowerCase()));
      patch.tags = [...new Set([...current, ...(set.addTags ?? [])])].filter(
        (t) => !remove.has(t.toLowerCase()),
      );
    }
    if (set.categoryId || set.entityId) {
      if (!spec || spec.type !== 'standard' || spec.splits.length !== 1) return null;
      let categoryId = set.categoryId;
      if (!categoryId && set.entityId) {
        // Same-named category in the target entity, else that entity's uncategorized account.
        const current = await trx
          .selectFrom('app.ledger_account')
          .select(['name', 'type'])
          .where('id', '=', spec.splits[0]!.accountId)
          .executeTakeFirstOrThrow();
        const match = await trx
          .selectFrom('app.ledger_account')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', set.entityId)
          .where('is_category', '=', true)
          .where('name', '=', current.name)
          .where('type', '=', current.type)
          .executeTakeFirst();
        categoryId =
          match?.id ??
          (
            await trx
              .selectFrom('app.ledger_account')
              .select('id')
              .where('entity_id', '=', set.entityId)
              .where(
                'system_role',
                '=',
                BigInt(spec.amount) < 0n ? 'uncategorized_expense' : 'uncategorized_income',
              )
              .executeTakeFirstOrThrow()
          ).id;
      }
      patch.categoryId = categoryId;
    }
    return patch;
  }

  private async lockRow(trx: Trx, ctx: Ctx, id: string, ifMatch?: string) {
    const row = await trx
      .selectFrom('app.transaction')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound('Transaction');
    if (ifMatch !== undefined && ifMatch.replace(/^W\//, '').replace(/"/g, '') !== `v${row.version}`) {
      throw new VersionMismatchError();
    }
    return row;
  }

  private async tagNames(trx: Trx, ctx: Ctx, id: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('app.transaction_tag as tt')
      .innerJoin('app.tag as t', 't.id', 'tt.tag_id')
      .select('t.name')
      .where('tt.workspace_id', '=', ctx.workspaceId)
      .where('tt.transaction_id', '=', id)
      .orderBy('t.name')
      .execute();
    return rows.map((r) => r.name);
  }

  private async setTags(trx: Trx, ctx: Ctx, transactionId: string, names: string[]): Promise<void> {
    await trx
      .deleteFrom('app.transaction_tag')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('transaction_id', '=', transactionId)
      .execute();
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
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
            'a.is_category',
            'a.system_role',
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
    const tags = await trx
      .selectFrom('app.transaction_tag as tt')
      .innerJoin('app.tag as t', 't.id', 'tt.tag_id')
      .select(['tt.transaction_id', 't.name'])
      .where('tt.workspace_id', '=', ctx.workspaceId)
      .where('tt.transaction_id', 'in', ids)
      .orderBy('t.name')
      .execute();
    const order = new Map(ids.map((id, i) => [id, i]));
    const result: TransactionDto[] = [];
    for (const t of txns.sort((a, b) => order.get(a.id)! - order.get(b.id)!)) {
      result.push({
        id: t.id,
        date: t.txn_date,
        payee: t.payee_raw,
        description: t.description,
        status: t.status,
        reviewState: t.review_state,
        source: t.source,
        version: t.version.toString(),
        memo: await this.crypto.decrypt(trx, ctx.workspaceId, 'transaction.memo', t.memo_enc),
        tags: tags.filter((x) => x.transaction_id === t.id).map((x) => x.name),
        recurringItemId: t.recurring_item_id,
        amount: specAmount(t.spec as TransactionSpec | null),
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
                isCategory: p.is_category,
                systemRole: p.system_role,
              })),
          })),
      });
    }
    return result;
  }
}

/** Signed amount from the paying account's view: transfers show the amount leaving the source account. */
function specAmount(spec: TransactionSpec | null): TransactionDto['amount'] {
  if (!spec) return null;
  const amount = spec.type === 'transfer' ? (-BigInt(spec.amount)).toString() : spec.amount;
  return { amount, currency: spec.currency as NonNullable<TransactionDto['amount']>['currency'] };
}
