/**
 * The offline sync engine (PLT-05, ADR-0013): optimistic local writes into an outbox, push with idempotent
 * replay and back-off, pull of resolved rows since the last seq, and conflict notices for field-group
 * last-write-wins merges done by the server.
 *
 * Rejected ops become drafts: the optimistic row stays as the user left it (still `pending`) and the draft
 * count in `state()` tells the app to ask the user to edit or discard it. Discarding restores the server copy.
 */
import type {
  CategoryDto,
  CreateTransactionRequest,
  PushOp,
  SyncPullResponse,
  TransactionDto,
  UpdateTransactionRequest,
} from '@montra/schemas';
import {
  applyPatchToLocal,
  foldIntoCreate,
  mergePatches,
  projectCreate,
  projectTransaction,
  replayOp,
} from './projection.js';
import { TransportError } from './transport.js';
import type {
  LocalTransaction,
  OutboxItem,
  SyncEngineApi,
  SyncEngineOptions,
  SyncEvent,
  SyncState,
} from './types.js';

const PUSH_BATCH = 100;
const PULL_LIMIT = 500;
const MAX_BACKOFF_MS = 5 * 60_000;

const META = {
  latestSeq: 'latestSeq',
  bootstrappedAt: 'bootstrappedAt',
  lastSyncedAt: 'lastSyncedAt',
  reviewCount: 'reviewCount',
} as const;

/** Back-off after `attempts` failed pushes: 2 s, 4 s, 8 s … capped at 5 minutes. */
export const backoffMs = (attempts: number): number => Math.min(2 ** attempts * 1000, MAX_BACKOFF_MS);

/** Auth and permission failures: keep the op as it is and try again later (the user may sign in again). */
const isAuthError = (e: unknown) => e instanceof TransportError && (e.status === 401 || e.status === 403);
const isRetryable = (e: unknown) => !(e instanceof TransportError) || e.retryable || isAuthError(e);

export class SyncEngine implements SyncEngineApi {
  private readonly store: SyncEngineOptions['store'];
  private readonly transport: SyncEngineOptions['transport'];
  private readonly days: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly onEvent: (e: SyncEvent) => void;
  private online = true;
  private running: Promise<void> | null = null;
  private rerun = false;

  constructor(opts: SyncEngineOptions) {
    this.store = opts.store;
    this.transport = opts.transport;
    this.days = opts.days ?? 90;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  // ----- Lifecycle ---------------------------------------------------------------------------------------

  async bootstrap(): Promise<void> {
    let since = '0';
    const seen = new Set<string>();
    let first = true;
    let pulledTx = 0;
    let removed = 0;
    for (;;) {
      const page = await this.transport.pull({ since, days: this.days, limit: PULL_LIMIT });
      await this.store.transaction(async () => {
        const counts = await this.applyPage(page, first && page.full);
        pulledTx += counts.transactions;
        removed += counts.removed;
      });
      for (const t of page.transactions) seen.add(t.id);
      first = false;
      since = page.latestSeq;
      if (!page.hasMore) break;
    }
    // Rows the device kept from before (another account, an older window) that the bootstrap didn't send.
    await this.store.transaction(async () => {
      const busy = await this.busyIds();
      const stale = (await this.store.listTransactions({}))
        .filter((t) => !seen.has(t.id) && !t.pending && !busy.has(t.id))
        .map((t) => t.id);
      if (stale.length) await this.store.removeTransactions(stale);
      removed += stale.length;
      await this.store.setMeta(META.latestSeq, since);
      await this.store.setMeta(META.bootstrappedAt, this.now().toISOString());
      await this.store.setMeta(META.lastSyncedAt, this.now().toISOString());
    });
    this.emit({ type: 'pulled', transactions: pulledTx, removed });
    await this.emitState();
  }

  sync(): Promise<void> {
    if (!this.online) return Promise.resolve();
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      await this.emitState();
      do {
        this.rerun = false;
        try {
          await this.pushOutbox();
          if (this.online) await this.pullChanges();
        } catch (e) {
          this.emit({ type: 'error', error: e as Error });
        }
      } while (this.rerun && this.online);
    })().finally(() => {
      this.running = null;
      void this.emitState();
    });
    return this.running;
  }

  setOnline(online: boolean): void {
    this.online = online;
    void this.emitState();
  }

  async state(): Promise<SyncState> {
    const outbox = await this.store.outbox();
    return {
      online: this.online,
      syncing: this.running !== null,
      lastSyncedAt: await this.store.getMeta(META.lastSyncedAt),
      latestSeq: (await this.store.getMeta(META.latestSeq)) ?? '0',
      pending: outbox.filter((o) => o.status !== 'draft').length,
      drafts: outbox.filter((o) => o.status === 'draft').length,
      reviewCount: Number((await this.store.getMeta(META.reviewCount)) ?? '0'),
    };
  }

  async signOut(): Promise<void> {
    this.online = false;
    if (this.running) await this.running.catch(() => {});
    await this.store.wipe();
  }

  // ----- Local writes -----------------------------------------------------------------------------------

  async createTransaction(data: CreateTransactionRequest): Promise<LocalTransaction> {
    const id = this.newId();
    const categories = await this.store.getReference('categories');
    const local = projectCreate(id, data, categories);
    await this.store.transaction(async () => {
      await this.store.putTransactions([local]);
      await this.enqueue({ kind: 'transaction.create', opId: this.newId(), changedAt: this.stamp(), id, data });
    });
    this.kick();
    return local;
  }

  async updateTransaction(id: string, patch: UpdateTransactionRequest): Promise<LocalTransaction> {
    const categories = await this.store.getReference('categories');
    const next = await this.store.transaction(async () => {
      const local = await this.require(id);
      const updated = { ...applyPatchToLocal(local, patch, categories), pending: true };
      await this.store.putTransactions([updated]);
      const ops = (await this.store.outbox()).filter((o) => o.op.id === id);
      const last = ops.at(-1);
      const create = ops.find((o) => o.op.kind === 'transaction.create' && o.status === 'pending');
      if (create && create.op.kind === 'transaction.create') {
        // Not pushed yet: fold the edit into the create so it stays one atomic op.
        await this.store.updateOutbox(create.op.opId, {
          op: { ...create.op, data: foldIntoCreate(create.op.data, patch), changedAt: this.stamp() },
        });
      } else if (last && last.status === 'pending' && last.op.kind === 'transaction.update') {
        // Coalesce consecutive edits: earliest baseVersion, latest changedAt.
        await this.store.updateOutbox(last.op.opId, {
          op: { ...last.op, data: mergePatches(last.op.data, patch), changedAt: this.stamp() },
        });
      } else {
        await this.enqueue({
          kind: 'transaction.update',
          opId: this.newId(),
          changedAt: this.stamp(),
          id,
          baseVersion: local.server?.version ?? local.version,
          data: patch,
        });
      }
      return updated;
    });
    this.kick();
    return next;
  }

  async deleteTransaction(id: string): Promise<void> {
    await this.store.transaction(async () => {
      const local = await this.store.getTransaction(id);
      const ops = (await this.store.outbox()).filter((o) => o.op.id === id);
      const create = ops.find((o) => o.op.kind === 'transaction.create');
      if (create && create.status !== 'inflight') {
        // Never reached the server: drop it and everything queued after it.
        await this.store.removeOutbox(ops.map((o) => o.op.opId));
        await this.store.removeTransactions([id]);
        return;
      }
      // Edits queued for a row that is going away are pointless.
      await this.store.removeOutbox(ops.filter((o) => o.status !== 'inflight').map((o) => o.op.opId));
      await this.enqueue({
        kind: 'transaction.delete',
        opId: this.newId(),
        changedAt: this.stamp(),
        id,
        ...(local?.server ? { baseVersion: local.server.version } : {}),
      });
      await this.store.removeTransactions([id]);
    });
    this.kick();
  }

  async acceptReview(id: string): Promise<void> {
    const categories = await this.store.getReference('categories');
    await this.store.transaction(async () => {
      const local = await this.require(id);
      const op: PushOp = { kind: 'review.accept', opId: this.newId(), changedAt: this.stamp(), id };
      await this.store.putTransactions([{ ...replayOp(local, op, categories)!, pending: true }]);
      await this.enqueue(op);
    });
    this.kick();
  }

  async resolveReview(id: string, categoryId: string, memberId?: string | null): Promise<void> {
    const categories = await this.store.getReference('categories');
    await this.store.transaction(async () => {
      const local = await this.require(id);
      const op: PushOp = {
        kind: 'review.resolve',
        opId: this.newId(),
        changedAt: this.stamp(),
        id,
        categoryId,
        ...(memberId !== undefined ? { memberId } : {}),
      };
      await this.store.putTransactions([{ ...replayOp(local, op, categories)!, pending: true }]);
      await this.enqueue(op);
    });
    this.kick();
  }

  // ----- Drafts ------------------------------------------------------------------------------------------

  async discardDraft(opId: string): Promise<void> {
    const categories = await this.store.getReference('categories');
    await this.store.transaction(async () => {
      const item = (await this.store.outbox()).find((o) => o.op.opId === opId);
      if (!item) return;
      const id = item.op.id;
      if (item.op.kind === 'transaction.create') {
        const all = (await this.store.outbox()).filter((o) => o.op.id === id).map((o) => o.op.opId);
        await this.store.removeOutbox(all);
        await this.store.removeTransactions([id]);
        return;
      }
      await this.store.removeOutbox([opId]);
      await this.rebuild(id, categories);
    });
    await this.emitState();
  }

  async retryDraft(opId: string, data?: CreateTransactionRequest | UpdateTransactionRequest): Promise<void> {
    const categories = await this.store.getReference('categories');
    await this.store.transaction(async () => {
      const item = (await this.store.outbox()).find((o) => o.op.opId === opId);
      if (!item) return;
      let op = item.op;
      if (data && (op.kind === 'transaction.create' || op.kind === 'transaction.update'))
        op = { ...op, data, changedAt: this.stamp() } as PushOp;
      await this.store.updateOutbox(opId, { op, status: 'pending', attempts: 0, error: null, nextAttemptAt: null });
      if (data) await this.rebuild(op.id, categories);
    });
    this.kick();
  }

  // ----- Push --------------------------------------------------------------------------------------------

  private async pushOutbox(): Promise<void> {
    // An op left in flight by a previous run (app killed mid-request) is simply replayed: opIds are idempotent.
    for (const o of await this.store.outbox())
      if (o.status === 'inflight') await this.store.updateOutbox(o.op.opId, { status: 'pending' });
    let applied = 0;
    let merged = 0;
    let rejected = 0;
    for (;;) {
      const now = this.now().getTime();
      const ready = (await this.store.outbox())
        .filter((o) => o.status === 'pending' && (!o.nextAttemptAt || Date.parse(o.nextAttemptAt) <= now))
        .slice(0, PUSH_BATCH);
      if (ready.length === 0) break;
      for (const o of ready) await this.store.updateOutbox(o.op.opId, { status: 'inflight' });
      let res;
      try {
        res = await this.transport.push({ ops: ready.map((o) => o.op) });
      } catch (e) {
        await this.store.transaction(async () => {
          for (const o of ready) {
            if (isRetryable(e)) {
              const attempts = o.attempts + 1;
              await this.store.updateOutbox(o.op.opId, {
                status: 'pending',
                attempts,
                nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString(),
              });
            } else {
              const err = e as TransportError;
              await this.store.updateOutbox(o.op.opId, {
                status: 'draft',
                error: { code: err.code, message: err.message },
              });
            }
          }
        });
        this.emit({ type: 'error', error: e as Error });
        if (isRetryable(e)) break;
        continue;
      }
      const categories = await this.store.getReference('categories');
      await this.store.transaction(async () => {
        const byOp = new Map(ready.map((o) => [o.op.opId, o]));
        for (const r of res.results) {
          const item = byOp.get(r.opId);
          if (!item) continue;
          byOp.delete(r.opId);
          if (r.status === 'rejected') {
            rejected++;
            await this.store.updateOutbox(r.opId, {
              status: 'draft',
              error: r.error ?? { code: 'rejected', message: 'The server rejected this change' },
            });
            continue;
          }
          if (r.status === 'merged') merged++;
          else applied++;
          await this.store.removeOutbox([r.opId]);
          if (r.transaction) await this.putServer(r.transaction, categories);
          else if (item.op.kind === 'transaction.delete' && !(await this.busyIds()).has(item.op.id))
            await this.store.removeTransactions([item.op.id]);
          if (r.conflicts.length) {
            const notice = {
              transactionId: item.op.id,
              opId: r.opId,
              conflicts: r.conflicts,
              at: this.now().toISOString(),
            };
            await this.store.addConflict(notice);
            this.emit({ type: 'conflict', notice });
          }
        }
        // Ops the server didn't answer stay queued for the next round.
        for (const o of byOp.values()) await this.store.updateOutbox(o.op.opId, { status: 'pending' });
      });
      if (byOp(res.results, ready)) break;
    }
    if (applied + merged + rejected > 0) this.emit({ type: 'pushed', applied, merged, rejected });
  }

  // ----- Pull --------------------------------------------------------------------------------------------

  private async pullChanges(): Promise<void> {
    const since0 = await this.store.getMeta(META.latestSeq);
    if (since0 === null) return this.bootstrap();
    let since = since0;
    let pulled = 0;
    let removed = 0;
    for (;;) {
      const page = await this.transport.pull({ since, days: this.days, limit: PULL_LIMIT });
      await this.store.transaction(async () => {
        const c = await this.applyPage(page, page.full);
        pulled += c.transactions;
        removed += c.removed;
        await this.store.setMeta(META.latestSeq, page.latestSeq);
      });
      since = page.latestSeq;
      if (!page.hasMore) break;
    }
    await this.store.setMeta(META.lastSyncedAt, this.now().toISOString());
    if (pulled + removed > 0) this.emit({ type: 'pulled', transactions: pulled, removed });
  }

  private async applyPage(page: SyncPullResponse, replace: boolean) {
    const refs = {
      accounts: page.accounts,
      categories: page.categories,
      members: page.members,
      entities: page.entities,
    };
    if (replace) await this.store.replaceReference(refs);
    else
      await this.store.mergeReference(
        Object.fromEntries(Object.entries(refs).filter(([, rows]) => rows.length > 0)),
      );
    const categories = await this.store.getReference('categories');
    for (const t of page.transactions) await this.putServer(t, categories);
    const busy = await this.busyIds();
    const gone = page.removedTransactions.filter((id) => !busy.has(id));
    if (gone.length) await this.store.removeTransactions(gone);
    await this.store.setMeta(META.reviewCount, String(page.reviewCount));
    return { transactions: page.transactions.length, removed: gone.length };
  }

  /** Stores a server copy, re-applying queued ops for the same row so pending edits survive a pull. */
  private async putServer(dto: TransactionDto, categories: CategoryDto[]): Promise<void> {
    const ops = (await this.store.outbox()).filter((o) => o.op.id === dto.id);
    let local: LocalTransaction | null = projectTransaction(dto, categories);
    for (const o of ops) {
      local = replayOp(local, o.op, categories);
      if (!local) break;
    }
    if (!local) {
      await this.store.removeTransactions([dto.id]);
      return;
    }
    await this.store.putTransactions([{ ...local, pending: ops.length > 0, server: dto }]);
  }

  /** Rebuilds a row from its server copy plus whatever is still queued for it. */
  private async rebuild(id: string, categories: CategoryDto[]): Promise<void> {
    const local = await this.store.getTransaction(id);
    const ops = (await this.store.outbox()).filter((o) => o.op.id === id);
    if (local?.server) {
      await this.putServer(local.server, categories);
      return;
    }
    const create = ops.find((o) => o.op.kind === 'transaction.create');
    if (create && create.op.kind === 'transaction.create') {
      let row: LocalTransaction | null = projectCreate(id, create.op.data, categories);
      for (const o of ops.filter((x) => x !== create)) row = row && replayOp(row, o.op, categories);
      if (row) await this.store.putTransactions([row]);
      else await this.store.removeTransactions([id]);
    } else if (local) await this.store.removeTransactions([id]);
  }

  // ----- Helpers -----------------------------------------------------------------------------------------

  private async enqueue(op: PushOp): Promise<void> {
    const item: OutboxItem = {
      op,
      status: 'pending',
      attempts: 0,
      error: null,
      createdAt: this.now().toISOString(),
      nextAttemptAt: null,
    };
    await this.store.enqueue(item);
  }

  /** Ids with queued ops (their local rows must not be dropped or overwritten by a pull). */
  private async busyIds(): Promise<Set<string>> {
    return new Set((await this.store.outbox()).map((o) => o.op.id));
  }

  private async require(id: string): Promise<LocalTransaction> {
    const local = await this.store.getTransaction(id);
    if (!local) throw new Error(`Transaction ${id} is not on this device`);
    return local;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Background sync after a local write; failures surface as events, never as rejections. */
  private kick(): void {
    void this.emitState();
    if (!this.online) return;
    this.sync().catch((e: unknown) => this.emit({ type: 'error', error: e as Error }));
  }

  private emit(e: SyncEvent): void {
    try {
      this.onEvent(e);
    } catch {
      // listeners must not break the engine
    }
  }

  private async emitState(): Promise<void> {
    try {
      this.emit({ type: 'state', state: await this.state() });
    } catch {
      // the store may be mid-wipe
    }
  }
}

/** True when the server answered nothing from this batch (avoid looping on the same ops). */
function byOp(results: Array<{ opId: string }>, ready: OutboxItem[]): boolean {
  const answered = new Set(results.map((r) => r.opId));
  return !ready.some((o) => answered.has(o.op.opId));
}
