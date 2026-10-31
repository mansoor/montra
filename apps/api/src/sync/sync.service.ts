import { Inject, Injectable } from '@nestjs/common';
import type { Trx } from '@montra/db';
import { addDays, calendarDate } from '@montra/domain';
import {
  FIELD_GROUPS,
  type ConflictDto,
  type FieldGroup,
  type PushOp,
  type PushResultDto,
  type SyncPullQuery,
  type SyncPullResponse,
  type SyncPushResponse,
  type TransactionDto,
  type UpdateTransactionRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError } from '../common/errors.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { ReviewService } from '../categorization/review.service.js';
import { toEntityDto, toMemberDto } from '../settings/settings.controller.js';

type Ctx = { workspaceId: string; userId: string };
type Clock = Record<string, { v: number; at: string }>;

const BOOTSTRAP_MAX = 5000;
/** Tables whose change means the member's visibility may have changed: resend everything. */
const ACCESS_TABLES = new Set(['entity_grant', 'workspace_member']);

/** Offline sync for devices (PLT-05, ADR-0013): resolved pulls and an idempotent outbox push. */
@Injectable()
export class SyncService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(ReviewService) private readonly review: ReviewService,
  ) {}

  // ----- Pull ---------------------------------------------------------------------------------------------

  async pull(ctx: Ctx, q: SyncPullQuery): Promise<SyncPullResponse> {
    if (q.since === '0') return this.bootstrap(ctx, q.days);
    const page = await this.db.run(ctx, (trx) => this.feedPage(trx, ctx, BigInt(q.since), q.limit));
    if (page.rows.some((r) => ACCESS_TABLES.has(r.table_name))) return this.bootstrap(ctx, q.days);

    const tables = new Set(page.rows.map((r) => r.table_name));
    const out = await this.db.run(ctx, async (trx) => {
      const ids = new Set<string>();
      const entryIds: string[] = [];
      const postingIds: string[] = [];
      for (const r of page.rows) {
        if (r.table_name === 'transaction') ids.add(r.row_id);
        else if (r.table_name === 'transaction_tag') ids.add(r.row_id.split(':')[0]!);
        else if (r.table_name === 'journal_entry') entryIds.push(r.row_id);
        else if (r.table_name === 'posting') postingIds.push(r.row_id);
      }
      if (entryIds.length)
        for (const e of await trx
          .selectFrom('app.journal_entry')
          .select('transaction_id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', entryIds)
          .execute())
          if (e.transaction_id) ids.add(e.transaction_id);
      if (postingIds.length)
        for (const p of await trx
          .selectFrom('app.posting as p')
          .innerJoin('app.journal_entry as je', (j) =>
            j.onRef('je.workspace_id', '=', 'p.workspace_id').onRef('je.id', '=', 'p.journal_entry_id'),
          )
          .select('je.transaction_id')
          .where('p.workspace_id', '=', ctx.workspaceId)
          .where('p.id', 'in', postingIds)
          .execute())
          if (p.transaction_id) ids.add(p.transaction_id);
      const { visible, removed } = await this.resolve(trx, ctx, [...ids]);
      return { visible, removed, reviewCount: await this.reviewCount(trx, ctx) };
    });
    const ref = await this.reference(ctx, {
      accounts: tables.has('ledger_account') || tables.has('bank_account') || tables.has('category_group'),
      members: tables.has('family_member'),
      entities: tables.has('entity') || tables.has('period_lock'),
    });
    return {
      latestSeq: page.latest.toString(),
      hasMore: page.hasMore,
      full: false,
      transactions: out.visible,
      removedTransactions: out.removed,
      ...ref,
      reviewCount: out.reviewCount,
    };
  }

  private async bootstrap(ctx: Ctx, days: number): Promise<SyncPullResponse> {
    const { head, visible, reviewCount } = await this.db.run(ctx, async (trx) => {
      // The head is read first, so changes made while we read are sent again on the next pull.
      const top = await trx
        .selectFrom('app.change_log')
        .select((eb) => eb.fn.max('seq').as('seq'))
        .where('workspace_id', '=', ctx.workspaceId)
        .executeTakeFirst();
      const from = addDays(calendarDate(new Date().toISOString().slice(0, 10)), -days);
      const rows = await trx
        .selectFrom('app.transaction')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('deleted_at', 'is', null)
        .where('status', '<>', 'void')
        .where((eb) => eb.or([eb('txn_date', '>=', from), eb('status', '=', 'scheduled')]))
        .orderBy('txn_date', 'desc')
        .orderBy('id', 'desc')
        .limit(BOOTSTRAP_MAX)
        .execute();
      return {
        head: BigInt(top?.seq ?? 0),
        visible: await this.transactions.load(
          trx,
          ctx,
          rows.map((r) => r.id),
        ),
        reviewCount: await this.reviewCount(trx, ctx),
      };
    });
    const ref = await this.reference(ctx, { accounts: true, members: true, entities: true });
    return {
      latestSeq: head.toString(),
      hasMore: false,
      full: true,
      transactions: visible,
      removedTransactions: [],
      accounts: ref.accounts,
      categories: ref.categories,
      members: ref.members,
      entities: ref.entities,
      reviewCount,
    };
  }

  /** A change-feed page that never ends inside one database transaction's group (ADR-0008). */
  private async feedPage(trx: Trx, ctx: Ctx, since: bigint, limit: number) {
    const rows = await trx
      .selectFrom('app.change_log')
      .select(['seq', 'sub', 'table_name', 'row_id', 'restricted'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('seq', '>', since)
      .orderBy('seq')
      .orderBy('sub')
      .limit(limit + 1)
      .execute();
    let page = rows.slice(0, limit);
    if (rows.length > limit && rows[limit]!.seq === page.at(-1)!.seq) {
      const last = page.at(-1)!;
      const rest = await trx
        .selectFrom('app.change_log')
        .select(['seq', 'sub', 'table_name', 'row_id', 'restricted'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('seq', '=', last.seq)
        .where('sub', '>', last.sub)
        .orderBy('sub')
        .execute();
      page = [...page, ...rest];
    }
    const latest = page.at(-1)?.seq ?? since;
    const more = await trx
      .selectFrom('app.change_log')
      .select('seq')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('seq', '>', latest)
      .limit(1)
      .executeTakeFirst();
    return { rows: page, latest: BigInt(latest), hasMore: Boolean(more) };
  }

  /** DTOs for the ids the member can still see; the rest (voided, deleted, hidden by RLS) are removed. */
  private async resolve(trx: Trx, ctx: Ctx, ids: string[]) {
    if (ids.length === 0) return { visible: [] as TransactionDto[], removed: [] as string[] };
    const live = await trx
      .selectFrom('app.transaction')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', ids)
      .where('deleted_at', 'is', null)
      .where('status', '<>', 'void')
      .execute();
    const liveIds = live.map((r) => r.id);
    const visible = await this.transactions.load(trx, ctx, liveIds);
    const seen = new Set(visible.map((t) => t.id));
    return { visible, removed: ids.filter((id) => !seen.has(id)) };
  }

  private async reviewCount(trx: Trx, ctx: Ctx): Promise<number> {
    const r = await trx
      .selectFrom('app.transaction')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('review_state', '=', 'needs_review')
      .where('status', '=', 'posted')
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  private async reference(ctx: Ctx, which: { accounts: boolean; members: boolean; entities: boolean }) {
    const [accounts, categories] = which.accounts
      ? await Promise.all([this.accounts.list(ctx, { includeArchived: true }), this.accounts.categories(ctx)])
      : [[], []];
    const { members, entities } = await this.db.run(ctx, async (trx) => ({
      members: which.members
        ? (
            await trx
              .selectFrom('app.family_member')
              .selectAll()
              .where('workspace_id', '=', ctx.workspaceId)
              .orderBy('created_at')
              .execute()
          ).map(toMemberDto)
        : [],
      entities: which.entities
        ? (
            await trx
              .selectFrom('app.entity as e')
              .leftJoin('app.period_lock as pl', (j) =>
                j.onRef('pl.workspace_id', '=', 'e.workspace_id').onRef('pl.entity_id', '=', 'e.id'),
              )
              .selectAll('e')
              .select('pl.locked_through')
              .where('e.workspace_id', '=', ctx.workspaceId)
              .orderBy('e.created_at')
              .execute()
          ).map((e) => toEntityDto(e) as SyncPullResponse['entities'][number])
        : [],
    }));
    return { accounts, categories, members, entities };
  }

  // ----- Push ---------------------------------------------------------------------------------------------

  async push(ctx: Ctx, ops: PushOp[]): Promise<SyncPushResponse> {
    const results: PushResultDto[] = [];
    for (const op of ops) results.push(await this.apply(ctx, op));
    // Replay records older than any realistic offline period are no longer needed (ADR-0013).
    await this.db.run(ctx, (trx) =>
      trx
        .deleteFrom('app.sync_op')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('created_at', '<', new Date(Date.now() - 30 * 86_400_000))
        .execute(),
    );
    const head = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.change_log')
        .select((eb) => eb.fn.max('seq').as('seq'))
        .where('workspace_id', '=', ctx.workspaceId)
        .executeTakeFirst(),
    );
    return { results, latestSeq: String(head?.seq ?? 0) };
  }

  private async apply(ctx: Ctx, op: PushOp): Promise<PushResultDto> {
    const prior = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.sync_op')
        .select('result')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('op_id', '=', op.opId)
        .executeTakeFirst(),
    );
    if (prior) return { ...(prior.result as unknown as PushResultDto), status: 'duplicate' };
    try {
      return await this.db.run(ctx, async (trx) => {
        const result = await this.applyInTrx(trx, ctx, op);
        await this.record(trx, ctx, op, result);
        return result;
      });
    } catch (err) {
      if (!(err instanceof AppError)) throw err; // unexpected: the device retries the batch later
      const result: PushResultDto = {
        opId: op.opId,
        status: 'rejected',
        transaction: null,
        conflicts: [],
        error: { code: err.code, message: err.message },
      };
      // A rejection is final for this opId; the device keeps it as a draft and retries with a new op.
      await this.db.run(ctx, (trx) => this.record(trx, ctx, op, result));
      return result;
    }
  }

  private async record(trx: Trx, ctx: Ctx, op: PushOp, result: PushResultDto): Promise<void> {
    await trx
      .insertInto('app.sync_op')
      .values({
        workspace_id: ctx.workspaceId,
        op_id: op.opId,
        user_id: ctx.userId,
        kind: op.kind,
        result: JSON.stringify({ ...result, transaction: null }),
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'op_id']).doNothing())
      .execute();
  }

  private async applyInTrx(trx: Trx, ctx: Ctx, op: PushOp): Promise<PushResultDto> {
    const done = async (
      id: string,
      status: PushResultDto['status'],
      conflicts: ConflictDto[] = [],
    ): Promise<PushResultDto> => ({
      opId: op.opId,
      status,
      transaction: (await this.transactions.load(trx, ctx, [id]))[0] ?? null,
      conflicts,
      error: null,
    });
    switch (op.kind) {
      case 'transaction.create': {
        const exists = await trx
          .selectFrom('app.transaction')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', op.id)
          .executeTakeFirst();
        if (exists) return done(op.id, 'duplicate');
        await this.transactions.createManualInTrx(trx, ctx, op.data, op.id);
        return done(op.id, 'applied');
      }
      case 'transaction.update': {
        const { patch, conflicts, all } = await this.merge(trx, ctx, op);
        if (Object.keys(patch).length) await this.transactions.updateInTrx(trx, ctx, op.id, patch);
        return done(op.id, all && conflicts.length === 0 ? 'applied' : 'merged', conflicts);
      }
      case 'transaction.delete': {
        await this.transactions.removeInTrx(trx, ctx, op.id);
        return { opId: op.opId, status: 'applied', transaction: null, conflicts: [], error: null };
      }
      case 'review.accept': {
        await this.review.accept(trx, ctx, { transactionIds: [op.id] });
        return done(op.id, 'applied');
      }
      case 'review.resolve': {
        await this.review.resolve(trx, ctx, op.id, {
          categoryId: op.categoryId,
          ...(op.memberId !== undefined ? { memberId: op.memberId } : {}),
        });
        return done(op.id, 'applied');
      }
    }
  }

  /**
   * Field-group LWW (ADR-0013 §3): groups untouched on the server since `baseVersion` apply; for the others,
   * the later change wins — the device's time is clamped to now so a fast clock can't always win.
   */
  private async merge(
    trx: Trx,
    ctx: Ctx,
    op: Extract<PushOp, { kind: 'transaction.update' }>,
  ): Promise<{ patch: UpdateTransactionRequest; conflicts: ConflictDto[]; all: boolean }> {
    const row = await trx
      .selectFrom('app.transaction')
      .select(['version', 'field_clock', 'status'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', op.id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'not_found', 'Transaction not found');
    if (row.status === 'void')
      throw new AppError(409, 'transaction.void', 'The transaction was deleted on another device');
    const base = BigInt(op.baseVersion);
    const now = new Date();
    const clientAt = new Date(Math.min(Date.parse(op.changedAt), now.getTime()));
    const clock = (row.field_clock ?? {}) as unknown as Clock;
    const patch: Record<string, unknown> = {};
    const conflicts: ConflictDto[] = [];
    const data = op.data as Record<string, unknown>;
    let all = true;
    for (const group of Object.keys(FIELD_GROUPS) as FieldGroup[]) {
      const fields = (FIELD_GROUPS[group] as readonly string[]).filter((f) => data[f] !== undefined);
      if (fields.length === 0) continue;
      const c = clock[group];
      const untouched = row.version === base || !c || BigInt(c.v) <= base;
      let apply = untouched;
      if (!untouched) {
        apply = clientAt.getTime() > Date.parse(c.at);
        conflicts.push({
          group,
          winner: apply ? 'client' : 'server',
          serverChangedAt: new Date(c.at).toISOString(),
          clientChangedAt: clientAt.toISOString(),
        });
      }
      if (!apply) all = false;
      if (apply) for (const f of fields) patch[f] = data[f];
    }
    // categoryId and splits are exclusive in the request; keep whichever the device sent.
    return { patch: patch as UpdateTransactionRequest, conflicts, all };
  }
}
