import { z } from 'zod';
import { CategoryDto, AccountDto } from './accounts.js';
import { FamilyMemberDto } from './ledger.js';
import { Id } from './common.js';
import { CreateTransactionRequest, TransactionDto } from './transactions.js';
import { UpdateTransactionRequest } from './ledger.js';
import { EntityDto } from './workspaces.js';

// ----- Pull: resolved rows for the offline store (PLT-05, 05 §3, ADR-0013) ---------------------------------

/**
 * `GET /sync/pull?since=<seq>&days=90`. `since=0` is a bootstrap: reference data plus the last `days` of
 * transactions. Later pulls return only rows changed after `since`, already re-read under RLS.
 */
export const SyncPullQuery = z.object({
  since: z.string().regex(/^\d+$/).default('0'),
  days: z.coerce.number().int().min(1).max(730).default(90),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type SyncPullQuery = z.output<typeof SyncPullQuery>;

export const SyncPullResponse = z.object({
  latestSeq: z.string(),
  hasMore: z.boolean(),
  /** True for a bootstrap page: the client replaces its reference tables instead of merging. */
  full: z.boolean(),
  transactions: z.array(TransactionDto),
  /** Voided, deleted or no longer visible to this member. */
  removedTransactions: z.array(z.string()),
  accounts: z.array(AccountDto),
  categories: z.array(CategoryDto),
  members: z.array(FamilyMemberDto),
  entities: z.array(EntityDto),
  reviewCount: z.number(),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponse>;

// ----- Push: the offline outbox (ADR-0013) ---------------------------------------------------------------

/**
 * Field groups for last-write-wins. `ledger` is atomic so the result always balances: account, amount,
 * category, splits and member. The others are independent.
 */
export const FIELD_GROUPS = {
  ledger: ['accountId', 'amount', 'categoryId', 'splits', 'memberId'],
  payee: ['payee', 'description'],
  date: ['date'],
  memo: ['memo'],
  tags: ['tags'],
  review: ['reviewState'],
} as const;
export type FieldGroup = keyof typeof FIELD_GROUPS;
export const FieldGroupDto = z.enum(['ledger', 'payee', 'date', 'memo', 'tags', 'review']);

const OpBase = z.object({
  /** Client-generated; replaying the same op is a no-op that returns the first result. */
  opId: Id,
  /** When the user made the change on the device (ISO 8601). */
  changedAt: z.string().datetime({ offset: true }),
});

export const PushOp = z.discriminatedUnion('kind', [
  OpBase.extend({
    kind: z.literal('transaction.create'),
    /** Client-generated transaction id (idempotent create). */
    id: Id,
    data: CreateTransactionRequest,
  }),
  OpBase.extend({
    kind: z.literal('transaction.update'),
    id: Id,
    /** The version the edit was made on. */
    baseVersion: z.string().regex(/^\d+$/),
    data: UpdateTransactionRequest,
  }),
  OpBase.extend({
    kind: z.literal('transaction.delete'),
    id: Id,
    baseVersion: z.string().regex(/^\d+$/).optional(),
  }),
  OpBase.extend({
    kind: z.literal('review.accept'),
    id: Id,
  }),
  OpBase.extend({
    kind: z.literal('review.resolve'),
    id: Id,
    categoryId: Id,
    memberId: Id.nullable().optional(),
  }),
]);
export type PushOp = z.output<typeof PushOp>;

export const SyncPushRequest = z.object({ ops: z.array(PushOp).min(1).max(100) });
export type SyncPushRequest = z.output<typeof SyncPushRequest>;

export const ConflictDto = z.object({
  group: FieldGroupDto,
  /** Which side's value is now stored. */
  winner: z.enum(['server', 'client']),
  serverChangedAt: z.string(),
  clientChangedAt: z.string(),
});
export type ConflictDto = z.infer<typeof ConflictDto>;

export const PushResultDto = z.object({
  opId: z.string(),
  /**
   * applied: as sent. merged: applied with field-group LWW against newer server changes (see conflicts).
   * duplicate: this opId was already applied. rejected: kept on the device as a draft (see error).
   */
  status: z.enum(['applied', 'merged', 'duplicate', 'rejected']),
  transaction: TransactionDto.nullable(),
  conflicts: z.array(ConflictDto),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type PushResultDto = z.infer<typeof PushResultDto>;

export const SyncPushResponse = z.object({ results: z.array(PushResultDto), latestSeq: z.string() });
export type SyncPushResponse = z.infer<typeof SyncPushResponse>;

// ----- Push notification devices (NOT-01 transport) ------------------------------------------------------

export const RegisterPushDeviceRequest = z.object({
  /** Expo push token (ExponentPushToken[...]) or a raw APNs/FCM token. */
  token: z.string().min(10).max(300),
  platform: z.enum(['ios', 'android']),
  deviceName: z.string().max(100).optional(),
  appVersion: z.string().max(30).optional(),
});
export type RegisterPushDeviceRequest = z.output<typeof RegisterPushDeviceRequest>;

export const PushDeviceDto = z.object({
  id: z.string(),
  platform: z.enum(['ios', 'android']),
  deviceName: z.string().nullable(),
  appVersion: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
});
export type PushDeviceDto = z.infer<typeof PushDeviceDto>;
