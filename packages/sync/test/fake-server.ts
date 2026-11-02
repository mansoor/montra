/**
 * A scripted server double for the sync endpoints, with the ADR-0013 semantics the engine relies on:
 * idempotent opIds (a replay returns `duplicate` without a row), client-id creates, field-group
 * last-write-wins with clamped device times, rejections, and a change log paged by seq.
 */
import {
  FIELD_GROUPS,
  type CategoryDto,
  type ConflictDto,
  type FieldGroup,
  type PushOp,
  type PushResultDto,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
  type TransactionDto,
  type UpdateTransactionRequest,
} from '@montra/schemas';
import type { SyncPullParams, SyncTransport } from '../src/types.js';

export const ACCOUNT = 'acct-checking';
export const UNCATEGORIZED = 'cat-uncategorized';
export const CATEGORIES: CategoryDto[] = [
  { id: 'cat-groceries', name: 'Groceries' },
  { id: 'cat-dining', name: 'Dining out' },
  { id: 'cat-household', name: 'Household' },
].map((c) => ({ ...c, entityId: 'ent-1', type: 'expense', group: 'Daily living', archived: false })) as never;

interface Row {
  dto: TransactionDto;
  clock: Partial<Record<FieldGroup, { v: number; at: number }>>;
}

export interface TxInput {
  id: string;
  date?: string;
  payee?: string | null;
  amount?: string;
  categoryId?: string | null;
  memo?: string | null;
  reviewState?: string;
  suggestedCategoryId?: string | null;
}

/** Builds a server DTO the way the API shapes it (single split; uncategorized = the system account). */
export function makeDto(t: TxInput, version = 1): TransactionDto {
  const amount = t.amount ?? '-1000';
  const category = t.categoryId ?? UNCATEGORIZED;
  const name = CATEGORIES.find((c) => c.id === category)?.name ?? 'Uncategorized expense';
  return {
    id: t.id,
    date: t.date ?? '2026-10-20',
    payee: t.payee === undefined ? 'Shop' : t.payee,
    description: '',
    status: 'posted',
    reviewState: t.reviewState ?? (t.categoryId ? 'reviewed' : 'needs_review'),
    categorization: t.suggestedCategoryId
      ? {
          step: 'ai',
          confidence: 0.7,
          explanation: 'AI suggestion',
          ruleId: null,
          suggested: { categoryId: t.suggestedCategoryId, entityId: 'ent-1', memberId: null },
        }
      : null,
    merchant: null,
    source: 'manual',
    version: String(version),
    memo: t.memo ?? null,
    tags: [],
    recurringItemId: null,
    foreign: null,
    tripId: null,
    localTime: null,
    accountId: ACCOUNT,
    splits: [{ accountId: category, amount: String(-BigInt(amount)), memberId: null, memo: null }],
    amount: { amount, currency: 'USD' },
    entries: [
      {
        id: `je-${t.id}`,
        entityId: 'ent-1',
        date: t.date ?? '2026-10-20',
        kind: 'standard',
        description: '',
        postings: [
          {
            lineNo: 1,
            accountId: category,
            accountName: name,
            debit: String(-BigInt(amount)),
            credit: null,
            currency: 'USD',
            memberId: null,
            memo: null,
            isCategory: true,
            systemRole: t.categoryId ? null : 'uncategorized_expense',
          },
        ],
      },
    ],
  } as TransactionDto;
}

export class FakeServer implements SyncTransport {
  private rows = new Map<string, Row>();
  private log: Array<{ seq: number; id: string }> = [];
  private seq = 0;
  private ops = new Map<string, PushResultDto>();
  /** Every op the server received, in order (including replays). */
  readonly received: PushOp[] = [];
  pullCalls = 0;
  pushCalls = 0;
  /** Throw on the next push before (`before`) or after (`after`) applying it. */
  failNextPush: 'before' | 'after' | null = null;
  failPushAlways = false;

  constructor(private readonly clock: () => Date) {}

  // ----- Test helpers ----------------------------------------------------------------------------------

  seed(t: TxInput): TransactionDto {
    const dto = makeDto(t);
    this.rows.set(t.id, { dto, clock: {} });
    this.touch(t.id);
    return dto;
  }

  /** An edit made elsewhere (the web, another device) at the server's current time. */
  edit(id: string, patch: UpdateTransactionRequest): TransactionDto {
    return this.applyPatch(id, patch, this.clock().getTime());
  }

  remove(id: string): void {
    this.rows.delete(id);
    this.touch(id);
  }

  get(id: string): TransactionDto | null {
    return this.rows.get(id)?.dto ?? null;
  }

  count(): number {
    return this.rows.size;
  }

  // ----- Transport -------------------------------------------------------------------------------------

  async pull(params: SyncPullParams): Promise<SyncPullResponse> {
    this.pullCalls++;
    const since = Number(params.since);
    const base = {
      accounts: [],
      categories: [],
      members: [],
      entities: [],
      reviewCount: [...this.rows.values()].filter((r) => r.dto.reviewState === 'needs_review').length,
    };
    if (since === 0)
      return {
        ...base,
        categories: CATEGORIES,
        latestSeq: String(this.seq),
        hasMore: false,
        full: true,
        transactions: [...this.rows.values()].map((r) => r.dto),
        removedTransactions: [],
      };
    const changed = [...new Set(this.log.filter((l) => l.seq > since).map((l) => l.id))];
    return {
      ...base,
      latestSeq: String(this.seq),
      hasMore: false,
      full: false,
      transactions: changed.filter((id) => this.rows.has(id)).map((id) => this.rows.get(id)!.dto),
      removedTransactions: changed.filter((id) => !this.rows.has(id)),
    };
  }

  async push(req: SyncPushRequest): Promise<SyncPushResponse> {
    this.pushCalls++;
    if (this.failPushAlways || this.failNextPush === 'before') {
      this.failNextPush = null;
      throw Object.assign(new Error('network down'), { retryable: true });
    }
    const results = req.ops.map((op) => this.apply(op));
    if (this.failNextPush === 'after') {
      this.failNextPush = null;
      throw Object.assign(new Error('connection reset after commit'), { retryable: true });
    }
    return { results, latestSeq: String(this.seq) };
  }

  private apply(op: PushOp): PushResultDto {
    this.received.push(op);
    const prior = this.ops.get(op.opId);
    if (prior) return { ...prior, transaction: null, status: 'duplicate' };
    const result = this.applyNew(op);
    this.ops.set(op.opId, result);
    return result;
  }

  private applyNew(op: PushOp): PushResultDto {
    const ok = (
      id: string,
      status: PushResultDto['status'],
      conflicts: ConflictDto[] = [],
    ): PushResultDto => ({
      opId: op.opId,
      status,
      transaction: this.rows.get(id)?.dto ?? null,
      conflicts,
      error: null,
    });
    const reject = (code: string, message: string): PushResultDto => ({
      opId: op.opId,
      status: 'rejected',
      transaction: null,
      conflicts: [],
      error: { code, message },
    });
    switch (op.kind) {
      case 'transaction.create': {
        if (this.rows.has(op.id)) return ok(op.id, 'duplicate');
        if (op.data.accountId !== ACCOUNT) return reject('account.not_found', 'Unknown account');
        this.seed({
          id: op.id,
          date: op.data.date,
          payee: op.data.payee ?? null,
          amount: op.data.amount.amount,
          categoryId: op.data.categoryId ?? null,
          memo: op.data.memo ?? null,
        });
        return ok(op.id, 'applied');
      }
      case 'transaction.update': {
        const row = this.rows.get(op.id);
        if (!row) return reject('not_found', 'Transaction not found');
        if (op.data.categoryId && !CATEGORIES.some((c) => c.id === op.data.categoryId))
          return reject('category.invalid', 'Unknown category');
        const base = Number(op.baseVersion);
        const clientAt = Math.min(Date.parse(op.changedAt), this.clock().getTime());
        const patch: Record<string, unknown> = {};
        const conflicts: ConflictDto[] = [];
        let all = true;
        const data = op.data as Record<string, unknown>;
        for (const g of Object.keys(FIELD_GROUPS) as FieldGroup[]) {
          const fields = (FIELD_GROUPS[g] as readonly string[]).filter((f) => data[f] !== undefined);
          if (!fields.length) continue;
          const c = row.clock[g];
          const untouched = Number(row.dto.version) === base || !c || c.v <= base;
          let apply = untouched;
          if (!untouched) {
            apply = clientAt > c.at;
            conflicts.push({
              group: g,
              winner: apply ? 'client' : 'server',
              serverChangedAt: new Date(c.at).toISOString(),
              clientChangedAt: new Date(clientAt).toISOString(),
            });
          }
          if (!apply) all = false;
          else for (const f of fields) patch[f] = data[f];
        }
        if (Object.keys(patch).length) this.applyPatch(op.id, patch as UpdateTransactionRequest, clientAt);
        return ok(op.id, all && !conflicts.length ? 'applied' : 'merged', conflicts);
      }
      case 'transaction.delete':
        this.remove(op.id);
        return { opId: op.opId, status: 'applied', transaction: null, conflicts: [], error: null };
      case 'review.accept': {
        const row = this.rows.get(op.id);
        if (!row) return reject('not_found', 'Transaction not found');
        const cat = row.dto.categorization?.suggested?.categoryId;
        this.applyPatch(
          op.id,
          { ...(cat ? { categoryId: cat } : {}), reviewState: 'reviewed' },
          this.clock().getTime(),
        );
        return ok(op.id, 'applied');
      }
      case 'review.resolve':
        if (!this.rows.has(op.id)) return reject('not_found', 'Transaction not found');
        this.applyPatch(
          op.id,
          { categoryId: op.categoryId, reviewState: 'reviewed' },
          this.clock().getTime(),
        );
        return ok(op.id, 'applied');
    }
  }

  private applyPatch(id: string, patch: UpdateTransactionRequest, at: number): TransactionDto {
    const row = this.rows.get(id)!;
    const d = row.dto;
    const version = Number(d.version) + 1;
    const currentCategory = d.splits?.[0]?.accountId;
    const next = makeDto(
      {
        id,
        date: patch.date ?? d.date,
        payee: patch.payee !== undefined ? patch.payee : d.payee,
        amount: patch.amount?.amount ?? d.amount!.amount,
        categoryId:
          patch.categoryId ?? (currentCategory && currentCategory !== UNCATEGORIZED ? currentCategory : null),
        memo: patch.memo !== undefined ? patch.memo : d.memo,
        reviewState: patch.reviewState ?? (patch.categoryId ? 'reviewed' : d.reviewState),
        suggestedCategoryId: d.categorization?.suggested?.categoryId ?? null,
      },
      version,
    );
    for (const g of Object.keys(FIELD_GROUPS) as FieldGroup[])
      if (
        (FIELD_GROUPS[g] as readonly string[]).some(
          (f) => (patch as Record<string, unknown>)[f] !== undefined,
        )
      )
        row.clock[g] = { v: version, at };
    row.dto = next;
    this.touch(id);
    return next;
  }

  private touch(id: string): void {
    this.log.push({ seq: ++this.seq, id });
  }
}

/** A deterministic clock the tests move forward by hand. */
export class FakeClock {
  t = Date.parse('2026-10-31T09:00:00Z');
  now = () => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Predictable ids: id-1, id-2, … */
export const idGen = () => {
  let n = 0;
  return () => `id-${++n}`;
};
