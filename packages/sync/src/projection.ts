/**
 * The local projection of a transaction (what lists, the register and the review stack render offline) and
 * the pure helpers that apply edits to it. The device never runs ledger logic: the server's `TransactionDto`
 * is the truth, and pending edits are a thin overlay on top of it (ADR-0013 §4).
 */
import {
  FIELD_GROUPS,
  type CategoryDto,
  type CreateTransactionRequest,
  type FieldGroup,
  type PushOp,
  type TransactionDto,
  type UpdateTransactionRequest,
} from '@montra/schemas';
import type { LocalTransaction } from './types.js';

const isUncategorizedAccount = (dto: TransactionDto, accountId: string): boolean =>
  dto.entries.some((e) =>
    e.postings.some((p) => p.accountId === accountId && (p.systemRole ?? '').startsWith('uncategorized')),
  );

const categoryName = (categories: readonly CategoryDto[] | undefined, id: string | null): string | null =>
  id ? (categories?.find((c) => c.id === id)?.name ?? null) : null;

/** Server DTO → local row (not pending). */
export function projectTransaction(
  dto: TransactionDto,
  categories?: readonly CategoryDto[],
): LocalTransaction {
  const splits = dto.splits ?? [];
  const single = splits.length === 1 ? splits[0]! : null;
  const categoryId = single && !isUncategorizedAccount(dto, single.accountId) ? single.accountId : null;
  const postingName = categoryId
    ? (dto.entries.flatMap((e) => e.postings).find((p) => p.accountId === categoryId)?.accountName ?? null)
    : null;
  return {
    id: dto.id,
    date: dto.date,
    payee: dto.payee,
    description: dto.description,
    amount: dto.amount?.amount ?? null,
    currency: dto.amount?.currency ?? null,
    accountId: dto.accountId,
    categoryId,
    categoryName: categoryName(categories, categoryId) ?? postingName,
    memberId: single?.memberId ?? null,
    memo: dto.memo,
    tags: [...dto.tags],
    reviewState: dto.reviewState,
    status: dto.status,
    suggestedCategoryId: dto.categorization?.suggested?.categoryId ?? null,
    confidence: dto.categorization?.confidence ?? null,
    explanation: dto.categorization?.explanation ?? null,
    merchantName: dto.merchant?.name ?? null,
    version: dto.version,
    pending: false,
    server: dto,
  };
}

/** A create request made offline → optimistic local row (no server copy yet). */
export function projectCreate(
  id: string,
  data: CreateTransactionRequest,
  categories?: readonly CategoryDto[],
): LocalTransaction {
  const splitCategory = data.splits?.length === 1 ? data.splits[0]!.accountId : null;
  const categoryId = data.categoryId ?? splitCategory;
  const categorized = Boolean(data.categoryId || data.splits?.length);
  return {
    id,
    date: data.date,
    payee: data.payee ?? null,
    description: data.description ?? '',
    amount: data.amount.amount,
    currency: data.amount.currency,
    accountId: data.accountId,
    categoryId,
    categoryName: categoryName(categories, categoryId),
    memberId: data.memberId ?? data.splits?.[0]?.memberId ?? null,
    memo: data.memo ?? null,
    tags: [...(data.tags ?? [])],
    reviewState: categorized ? 'reviewed' : 'needs_review',
    status: 'posted',
    suggestedCategoryId: null,
    confidence: null,
    explanation: null,
    merchantName: null,
    version: '0',
    pending: true,
    server: null,
  };
}

/** Applies an update patch to a local row (pure; the caller decides `pending`). */
export function applyPatchToLocal(
  local: LocalTransaction,
  patch: UpdateTransactionRequest,
  categories?: readonly CategoryDto[],
): LocalTransaction {
  const next: LocalTransaction = { ...local, tags: [...local.tags] };
  if (patch.date !== undefined) next.date = patch.date;
  if (patch.accountId !== undefined) next.accountId = patch.accountId;
  if (patch.amount !== undefined) {
    next.amount = patch.amount.amount;
    next.currency = patch.amount.currency;
  }
  if (patch.payee !== undefined) next.payee = patch.payee;
  if (patch.description !== undefined) next.description = patch.description;
  let categorized = false;
  if (patch.categoryId !== undefined) {
    next.categoryId = patch.categoryId;
    categorized = true;
  } else if (patch.splits !== undefined) {
    next.categoryId = patch.splits.length === 1 ? patch.splits[0]!.accountId : null;
    if (patch.splits.length === 1 && patch.splits[0]!.memberId !== undefined)
      next.memberId = patch.splits[0]!.memberId ?? null;
    categorized = true;
  }
  if (categorized) next.categoryName = categoryName(categories, next.categoryId);
  if (patch.memberId !== undefined) next.memberId = patch.memberId;
  if (patch.memo !== undefined) next.memo = patch.memo;
  if (patch.tags !== undefined) next.tags = [...patch.tags];
  if (patch.reviewState !== undefined) next.reviewState = patch.reviewState;
  // Like the server: categorizing a transaction waiting for review marks it reviewed.
  else if (categorized && local.reviewState === 'needs_review') next.reviewState = 'reviewed';
  return next;
}

/** Field groups an update touches (ADR-0013 §3). */
export function groupsOf(patch: UpdateTransactionRequest): FieldGroup[] {
  const keys = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  return (Object.keys(FIELD_GROUPS) as FieldGroup[]).filter((g) =>
    (FIELD_GROUPS[g] as readonly string[]).some((f) => keys.includes(f)),
  );
}

/** Merges two update patches; `categoryId` and `splits` replace each other. */
export function mergePatches(
  a: UpdateTransactionRequest,
  b: UpdateTransactionRequest,
): UpdateTransactionRequest {
  const merged: UpdateTransactionRequest = { ...a, ...b };
  if (b.categoryId !== undefined) delete merged.splits;
  if (b.splits !== undefined) delete merged.categoryId;
  return merged;
}

/** Folds an update into a create that hasn't been pushed yet, so the create stays atomic. */
export function foldIntoCreate(
  data: CreateTransactionRequest,
  patch: UpdateTransactionRequest,
): CreateTransactionRequest {
  const next: CreateTransactionRequest = { ...data };
  if (patch.date !== undefined) next.date = patch.date;
  if (patch.accountId !== undefined) next.accountId = patch.accountId;
  if (patch.amount !== undefined) next.amount = patch.amount;
  if (patch.payee !== undefined) {
    if (patch.payee === null) delete next.payee;
    else next.payee = patch.payee;
  }
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.categoryId !== undefined) {
    next.categoryId = patch.categoryId;
    delete next.splits;
  }
  if (patch.splits !== undefined) {
    next.splits = patch.splits.map((s) => ({ ...s, memo: s.memo ?? undefined }));
    delete next.categoryId;
  }
  if (patch.memberId !== undefined) next.memberId = patch.memberId;
  if (patch.memo !== undefined) {
    if (patch.memo === null) delete next.memo;
    else next.memo = patch.memo;
  }
  if (patch.tags !== undefined) next.tags = patch.tags;
  // reviewState has no meaning on create: the server decides from the category.
  return next;
}

/** Re-applies a queued op on top of a (newer) server copy, so a pull never clobbers a pending edit. */
export function replayOp(
  local: LocalTransaction,
  op: PushOp,
  categories?: readonly CategoryDto[],
): LocalTransaction | null {
  switch (op.kind) {
    case 'transaction.create':
      return local;
    case 'transaction.update':
      return applyPatchToLocal(local, op.data, categories);
    case 'transaction.delete':
      return null;
    case 'review.accept':
      return {
        ...local,
        reviewState: 'reviewed',
        categoryId: local.suggestedCategoryId ?? local.categoryId,
        categoryName:
          categoryName(categories, local.suggestedCategoryId ?? local.categoryId) ?? local.categoryName,
      };
    case 'review.resolve':
      return {
        ...local,
        reviewState: 'reviewed',
        categoryId: op.categoryId,
        categoryName: categoryName(categories, op.categoryId),
        ...(op.memberId !== undefined ? { memberId: op.memberId } : {}),
      };
  }
}
