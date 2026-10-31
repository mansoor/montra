/**
 * Offline sync contract (PLT-05, 05 §3, ADR-0013). The engine is platform-neutral: mobile backs `SyncStore`
 * with encrypted expo-sqlite, tests with `MemoryStore`, and `SyncTransport` with the typed API client.
 */
import type {
  AccountDto,
  CategoryDto,
  ConflictDto,
  CreateTransactionRequest,
  EntityDto,
  FamilyMemberDto,
  PushOp,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  TransactionDto,
  UpdateTransactionRequest,
} from '@montra/schemas';

export type SyncPullParams = { since: string; days?: number; limit?: number };

export interface SyncTransport {
  pull(params: SyncPullParams): Promise<SyncPullResponse>;
  push(req: SyncPushRequest): Promise<SyncPushResponse>;
}

/** The flat projection of a transaction that lists, the register and the review stack render offline. */
export interface LocalTransaction {
  id: string;
  date: string;
  payee: string | null;
  description: string;
  /** Signed minor units from the paying account's view; null for manual journals. */
  amount: string | null;
  currency: string | null;
  accountId: string | null;
  /** Single category, or null when split, uncategorized or a transfer. */
  categoryId: string | null;
  categoryName: string | null;
  memberId: string | null;
  memo: string | null;
  tags: string[];
  reviewState: string;
  status: string;
  /** Suggested category for the review stack (categorization.suggested). */
  suggestedCategoryId: string | null;
  confidence: number | null;
  explanation: string | null;
  merchantName: string | null;
  version: string;
  /** Local edits waiting in the outbox. */
  pending: boolean;
  /** Server copy as last pulled (null for rows created offline and not yet pushed). */
  server: TransactionDto | null;
}

export type OutboxStatus = 'pending' | 'inflight' | 'draft';

export interface OutboxItem {
  op: PushOp;
  status: OutboxStatus;
  attempts: number;
  /** For drafts: why the server rejected it (shown to the user, who can edit or discard). */
  error: { code: string; message: string } | null;
  createdAt: string;
  nextAttemptAt: string | null;
}

export interface ConflictNotice {
  transactionId: string;
  opId: string;
  conflicts: ConflictDto[];
  at: string;
}

export type ReferenceTable = 'accounts' | 'categories' | 'members' | 'entities';
export interface ReferenceRows {
  accounts: AccountDto[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
  entities: EntityDto[];
}

export interface TransactionQuery {
  accountId?: string;
  reviewState?: string;
  search?: string;
  limit?: number;
  /** Keyset: rows strictly before (date, id) in date-desc order. */
  before?: { date: string; id: string };
}

/**
 * Persistence for the engine. Every method is atomic on its own; `transaction` groups several. Implementations
 * must encrypt at rest on devices (BAK-10) — the engine never sees keys.
 */
export interface SyncStore {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;

  putTransactions(rows: LocalTransaction[]): Promise<void>;
  removeTransactions(ids: string[]): Promise<void>;
  getTransaction(id: string): Promise<LocalTransaction | null>;
  listTransactions(q: TransactionQuery): Promise<LocalTransaction[]>;

  replaceReference(rows: ReferenceRows): Promise<void>;
  mergeReference(rows: Partial<ReferenceRows>): Promise<void>;
  getReference<T extends ReferenceTable>(table: T): Promise<ReferenceRows[T]>;

  enqueue(item: OutboxItem): Promise<void>;
  outbox(): Promise<OutboxItem[]>;
  updateOutbox(opId: string, patch: Partial<Omit<OutboxItem, 'op'>>): Promise<void>;
  removeOutbox(opIds: string[]): Promise<void>;

  addConflict(n: ConflictNotice): Promise<void>;
  conflicts(): Promise<ConflictNotice[]>;
  clearConflicts(ids?: string[]): Promise<void>;

  /** Sign-out (BAK-10): drop every row and the encryption key. */
  wipe(): Promise<void>;
}

export type SyncEvent =
  | { type: 'state'; state: SyncState }
  | { type: 'pulled'; transactions: number; removed: number }
  | { type: 'pushed'; applied: number; merged: number; rejected: number }
  | { type: 'conflict'; notice: ConflictNotice }
  | { type: 'error'; error: Error };

export interface SyncState {
  online: boolean;
  syncing: boolean;
  lastSyncedAt: string | null;
  latestSeq: string;
  pending: number;
  drafts: number;
  reviewCount: number;
}

export interface SyncEngineOptions {
  store: SyncStore;
  transport: SyncTransport;
  /** Days of history kept offline (default 90). */
  days?: number;
  now?: () => Date;
  /** UUID v4/v7 generator for client ids (opIds and offline-created transactions). */
  newId: () => string;
  onEvent?: (e: SyncEvent) => void;
}

/** Public surface the app uses. Implemented by `SyncEngine` in engine.ts. */
export interface SyncEngineApi {
  /** First run or after a wipe: full pull of reference data and recent history. */
  bootstrap(): Promise<void>;
  /** Push the outbox, then pull changes since the last seq. Safe to call often; concurrent calls coalesce. */
  sync(): Promise<void>;
  setOnline(online: boolean): void;
  state(): Promise<SyncState>;

  /** Optimistic local writes; each enqueues one outbox op. */
  createTransaction(data: CreateTransactionRequest): Promise<LocalTransaction>;
  updateTransaction(id: string, patch: UpdateTransactionRequest): Promise<LocalTransaction>;
  deleteTransaction(id: string): Promise<void>;
  acceptReview(id: string): Promise<void>;
  resolveReview(id: string, categoryId: string, memberId?: string | null): Promise<void>;

  /** Drafts the server rejected: retry after editing, or discard (restores the server copy). */
  discardDraft(opId: string): Promise<void>;
  retryDraft(opId: string, data?: CreateTransactionRequest | UpdateTransactionRequest): Promise<void>;

  signOut(): Promise<void>;
}
