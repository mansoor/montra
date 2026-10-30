/**
 * Transaction editor model (DE-10): turns a TransactionDto into form state and back into a minimal PATCH,
 * so untouched fields never go to the server (the API decides between rewrite, reclassify and reversal).
 */
import type { TransactionDto, UpdateTransactionInput } from '@montra/api-client';
import { minorToInput, parseAmountInput } from './money';
import { toSplitPayload, type Direction, type SplitLine } from './splits';
import { bankPosting } from './view-models';
import { staticT } from './i18n-static';

type T = (key: string, values?: Record<string, string | number>) => string;

export interface EditState {
  date: string;
  accountId: string;
  direction: Direction;
  /** Major-unit amount as typed (always positive; the direction carries the sign). */
  amount: string;
  currency: string;
  payee: string;
  description: string;
  memberId: string; // '' = Household
  memo: string;
  tags: string; // comma separated
  mode: 'category' | 'splits';
  categoryId: string;
  splits: SplitLine[];
  /** Transfers and manual journals only allow descriptive edits here. */
  ledgerEditable: boolean;
}

const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * Uses the transaction's stored input (`accountId`, `splits`) so scheduled occurrences, which have no
 * postings yet, edit the same way as posted ones; falls back to the postings for older rows.
 */
export function toEditState(t: TransactionDto, accountIds: ReadonlySet<string>): EditState {
  const bank = bankPosting(t, accountIds);
  const amount = t.amount ? BigInt(t.amount.amount) : 0n;
  const currency = t.amount?.currency ?? bank?.currency ?? 'USD';
  const isTransfer = t.entries[0]?.kind === 'transfer';
  const lines =
    t.splits ??
    t.entries
      .flatMap((e) => e.postings)
      .filter((p) => p.isCategory)
      .map((p) => ({
        accountId: p.accountId,
        amount: (BigInt(p.credit ?? '0') - BigInt(p.debit ?? '0')).toString(),
        memberId: p.memberId,
        memo: p.memo,
      }));
  const splits: SplitLine[] = lines.map((l, i) => ({
    key: `s${i}`,
    accountId: l.accountId,
    amount: minorToInput(abs(BigInt(l.amount)), currency),
    memo: l.memo ?? undefined,
  }));
  const accountId = t.accountId ?? bank?.accountId ?? '';
  return {
    date: t.date,
    accountId,
    direction: amount < 0n ? 'expense' : 'income',
    amount: t.amount ? minorToInput(abs(amount), currency) : '',
    currency,
    payee: t.payee ?? '',
    description: t.description,
    memberId: lines[0]?.memberId ?? bank?.memberId ?? '',
    memo: t.memo ?? '',
    tags: t.tags.join(', '),
    mode: lines.length > 1 ? 'splits' : 'category',
    // The uncategorized system account is "no category yet" in the editor (the review queue's state).
    categoryId: lines.length === 1 && !isUncategorized(t, lines[0]!.accountId) ? lines[0]!.accountId : '',
    splits: lines.length > 1 ? splits : [],
    ledgerEditable: !isTransfer && t.amount !== null && Boolean(accountId),
  };
}

function isUncategorized(t: TransactionDto, accountId: string): boolean {
  return t.entries.some((e) =>
    e.postings.some((p) => p.accountId === accountId && (p.systemRole ?? '').startsWith('uncategorized')),
  );
}

export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

const sameSplits = (a: SplitLine[], b: SplitLine[]) =>
  a.length === b.length &&
  a.every(
    (l, i) =>
      l.accountId === b[i]!.accountId && l.amount === b[i]!.amount && (l.memo ?? '') === (b[i]!.memo ?? ''),
  );

export type PatchResult =
  { ok: true; patch: UpdateTransactionInput } | { ok: false; field: string; error: string };

/** Builds a PATCH containing only what changed. Amount changes in split mode always resend the splits. */
export function buildPatch(initial: EditState, current: EditState, t: T = staticT): PatchResult {
  const patch: UpdateTransactionInput = {};
  if (current.date !== initial.date) patch.date = current.date as UpdateTransactionInput['date'];
  if (current.payee.trim() !== initial.payee) patch.payee = current.payee.trim() || null;
  if (current.description.trim() !== initial.description) patch.description = current.description.trim();
  if (current.memo !== initial.memo) patch.memo = current.memo || null;
  if (current.memberId !== initial.memberId) patch.memberId = current.memberId || null;
  const tags = parseTags(current.tags);
  if (tags.join('\u0000') !== parseTags(initial.tags).join('\u0000')) patch.tags = tags;

  if (initial.ledgerEditable) {
    const amountChanged = current.amount !== initial.amount || current.direction !== initial.direction;
    if (amountChanged) {
      const parsed = parseAmountInput(current.amount, current.currency, 'en-US', t);
      if (!parsed.ok) return { ok: false, field: 'amount', error: parsed.error };
      if (parsed.minor === 0n) return { ok: false, field: 'amount', error: t('money.not_zero') };
      const signed = current.direction === 'expense' ? -abs(parsed.minor) : abs(parsed.minor);
      patch.amount = { amount: signed.toString(), currency: current.currency };
    }
    if (current.accountId !== initial.accountId) patch.accountId = current.accountId;
    if (current.mode === 'splits') {
      if (amountChanged || initial.mode !== 'splits' || !sameSplits(current.splits, initial.splits)) {
        patch.splits = toSplitPayload(current.splits, current.currency, current.direction);
      }
    } else if (
      current.categoryId &&
      (current.categoryId !== initial.categoryId || initial.mode === 'splits')
    ) {
      patch.categoryId = current.categoryId;
    }
  }
  return { ok: true, patch };
}

export const isEmptyPatch = (p: UpdateTransactionInput) => Object.keys(p).length === 0;
