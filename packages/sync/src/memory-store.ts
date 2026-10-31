/**
 * In-memory `SyncStore`: used by tests and as the reference semantics for the device store (expo-sqlite).
 * `transaction()` snapshots state and restores it if the callback throws.
 */
import type {
  ConflictNotice,
  LocalTransaction,
  OutboxItem,
  ReferenceRows,
  ReferenceTable,
  SyncStore,
  TransactionQuery,
} from './types.js';

interface State {
  meta: Map<string, string>;
  transactions: Map<string, LocalTransaction>;
  reference: ReferenceRows;
  /** Insertion order is outbox order. */
  outbox: OutboxItem[];
  conflicts: ConflictNotice[];
}

const empty = (): State => ({
  meta: new Map(),
  transactions: new Map(),
  reference: { accounts: [], categories: [], members: [], entities: [] },
  outbox: [],
  conflicts: [],
});

const clone = <T>(v: T): T => structuredClone(v);

/** date desc, then id desc — the order lists render in. */
export const compareLocal = (a: LocalTransaction, b: LocalTransaction): number =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id === b.id ? 0 : a.id < b.id ? 1 : -1;

export class MemoryStore implements SyncStore {
  private s: State = empty();
  private depth = 0;

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn();
    const snapshot = clone(this.s);
    this.depth++;
    try {
      return await fn();
    } catch (e) {
      this.s = snapshot;
      throw e;
    } finally {
      this.depth--;
    }
  }

  async getMeta(key: string): Promise<string | null> {
    return this.s.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) this.s.meta.delete(key);
    else this.s.meta.set(key, value);
  }

  async putTransactions(rows: LocalTransaction[]): Promise<void> {
    for (const r of rows) this.s.transactions.set(r.id, clone(r));
  }

  async removeTransactions(ids: string[]): Promise<void> {
    for (const id of ids) this.s.transactions.delete(id);
  }

  async getTransaction(id: string): Promise<LocalTransaction | null> {
    const r = this.s.transactions.get(id);
    return r ? clone(r) : null;
  }

  async listTransactions(q: TransactionQuery): Promise<LocalTransaction[]> {
    const search = q.search?.trim().toLowerCase();
    const rows = [...this.s.transactions.values()]
      .filter((t) => (q.accountId ? t.accountId === q.accountId : true))
      .filter((t) => (q.reviewState ? t.reviewState === q.reviewState : true))
      .filter((t) =>
        search
          ? (t.payee ?? '').toLowerCase().includes(search) || t.description.toLowerCase().includes(search)
          : true,
      )
      .filter((t) =>
        q.before ? t.date < q.before.date || (t.date === q.before.date && t.id < q.before.id) : true,
      )
      .sort(compareLocal);
    return clone(q.limit !== undefined ? rows.slice(0, q.limit) : rows);
  }

  async replaceReference(rows: ReferenceRows): Promise<void> {
    this.s.reference = clone(rows);
  }

  async mergeReference(rows: Partial<ReferenceRows>): Promise<void> {
    for (const table of Object.keys(rows) as ReferenceTable[]) {
      const incoming = rows[table] ?? [];
      const current = this.s.reference[table] as Array<{ id: string }>;
      const byId = new Map(current.map((r) => [r.id, r]));
      for (const r of incoming as Array<{ id: string }>) byId.set(r.id, clone(r));
      (this.s.reference as unknown as Record<ReferenceTable, unknown[]>)[table] = [...byId.values()];
    }
  }

  async getReference<T extends ReferenceTable>(table: T): Promise<ReferenceRows[T]> {
    return clone(this.s.reference[table]);
  }

  async enqueue(item: OutboxItem): Promise<void> {
    this.s.outbox.push(clone(item));
  }

  async outbox(): Promise<OutboxItem[]> {
    return clone(this.s.outbox);
  }

  async updateOutbox(opId: string, patch: Partial<OutboxItem>): Promise<void> {
    const i = this.s.outbox.findIndex((o) => o.op.opId === opId);
    if (i < 0) return;
    const next = { ...this.s.outbox[i]!, ...clone(patch) };
    next.op = { ...next.op, opId } as OutboxItem['op'];
    this.s.outbox[i] = next;
  }

  async removeOutbox(opIds: string[]): Promise<void> {
    const drop = new Set(opIds);
    this.s.outbox = this.s.outbox.filter((o) => !drop.has(o.op.opId));
  }

  async addConflict(n: ConflictNotice): Promise<void> {
    this.s.conflicts.push(clone(n));
  }

  async conflicts(): Promise<ConflictNotice[]> {
    return clone(this.s.conflicts);
  }

  async clearConflicts(ids?: string[]): Promise<void> {
    if (!ids) this.s.conflicts = [];
    else {
      const drop = new Set(ids);
      this.s.conflicts = this.s.conflicts.filter((c) => !drop.has(c.opId));
    }
  }

  async wipe(): Promise<void> {
    this.s = empty();
  }
}
