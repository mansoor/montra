/**
 * Turns user-level transactions into balanced journal entries (design 04 §2).
 *
 * Sign conventions:
 * - A transaction `amount` is signed from the paying account's point of view: positive = money into the
 *   account (deposit, refund, card payment received), negative = money out (purchase, withdrawal).
 * - Split amounts use the same sign and must sum to the transaction amount.
 * - Postings are debit-positive. The paying account's posting equals `amount`; each split's posting is
 *   its negation.
 */
import type { CalendarDate } from '../calendar-date.js';
import { convert } from '../money.js';
import { decimalToString, type Decimal } from '../decimal.js';
import type { CurrencyCode } from '../currency.js';
import { LedgerError, validateEntry } from './validate.js';
import type {
  EntityRef,
  JournalEntryDraft,
  JournalKind,
  LedgerAccountRef,
  PostingDraft,
  PostingTags,
  SystemRole,
} from './types.js';

/** Supplies the system accounts the builder needs. Implemented by the API from the chart of accounts. */
export interface AccountResolver {
  entity(entityId: string): EntityRef;
  systemAccount(entityId: string, role: SystemRole): LedgerAccountRef;
  /**
   * Accounts used when money for entity `remote` moves through an account of entity `local` (DE-05).
   * `flow` is 'out' when `local` pays on behalf of `remote`, 'in' when `local` receives money that
   * belongs to `remote`. Returns the account to post in each entity.
   */
  interEntity(localEntityId: string, remoteEntityId: string, flow: 'out' | 'in'): {
    local: LedgerAccountRef;
    remote: LedgerAccountRef;
  };
}

export interface SplitInput extends PostingTags {
  readonly account: LedgerAccountRef;
  readonly amount: bigint;
}

export interface TransactionInput {
  readonly date: CalendarDate;
  readonly description: string;
  readonly account: LedgerAccountRef;
  readonly amount: bigint;
  /** Functional-currency units per 1 unit of the account currency; required when they differ. */
  readonly fxRate?: Decimal;
  readonly splits: readonly SplitInput[];
  readonly kind?: JournalKind;
  /** Tags applied to the paying account's posting (e.g. default member of a card, FAM-04). */
  readonly accountTags?: PostingTags;
}

class EntryWriter {
  private readonly postings: PostingDraft[] = [];
  constructor(readonly entity: EntityRef) {}

  add(account: LedgerAccountRef, amount: bigint, functionalAmount: bigint, tags: PostingTags = {}, fxRate?: Decimal) {
    if (account.entityId !== this.entity.id) {
      throw new LedgerError('ledger.cross_entity_posting', `Account ${account.id} is not in entity ${this.entity.id}`);
    }
    this.postings.push({
      lineNo: this.postings.length + 1,
      accountId: account.id,
      accountEntityId: account.entityId,
      currency: account.currency,
      amount,
      functionalAmount,
      fxRate: account.currency === this.entity.functionalCurrency || !fxRate ? null : decimalToString(fxRate),
      memberId: tags.memberId ?? null,
      propertyId: tags.propertyId ?? null,
      unitId: tags.unitId ?? null,
      memo: tags.memo ?? null,
    });
  }

  functionalTotal(): bigint {
    return this.postings.reduce((a, p) => a + p.functionalAmount, 0n);
  }

  /** Merges postings on the same account with identical tags and drops lines that net to zero. */
  build(date: CalendarDate, kind: JournalKind, description: string): JournalEntryDraft {
    const merged = new Map<string, PostingDraft>();
    for (const p of this.postings) {
      const key = [p.accountId, p.memberId, p.propertyId, p.unitId, p.memo, p.fxRate].join('|');
      const prev = merged.get(key);
      merged.set(
        key,
        prev
          ? { ...prev, amount: prev.amount + p.amount, functionalAmount: prev.functionalAmount + p.functionalAmount }
          : p,
      );
    }
    const postings = [...merged.values()]
      .filter((p) => p.amount !== 0n || p.functionalAmount !== 0n)
      .map((p, i) => ({ ...p, lineNo: i + 1 }));
    const entry: JournalEntryDraft = {
      entityId: this.entity.id,
      functionalCurrency: this.entity.functionalCurrency,
      entryDate: date,
      kind,
      description,
      postings,
    };
    validateEntry(entry);
    return entry;
  }
}

function toFunctional(amount: bigint, from: CurrencyCode, functional: CurrencyCode, rate?: Decimal): bigint {
  if (from === functional) return amount;
  if (!rate) throw new LedgerError('ledger.fx_rate_required', `An exchange rate ${from}→${functional} is required`);
  return convert({ amount, currency: from }, functional, rate).amount;
}

/** Posts any rounding residual from currency conversion to the entity's FX rounding account (CUR-07). */
function settleResidual(writer: EntryWriter, resolver: AccountResolver, role: SystemRole): void {
  const residual = writer.functionalTotal();
  if (residual === 0n) return;
  const account = resolver.systemAccount(writer.entity.id, role);
  writer.add(account, -residual, -residual);
}

/**
 * Builds the journal entries for an expense, income or split transaction, including splits that belong to
 * other entities (one entry per entity, ADR-0005). Returns entries in a stable order: paying entity first.
 */
export function buildTransactionEntries(input: TransactionInput, resolver: AccountResolver): JournalEntryDraft[] {
  if (input.splits.length === 0) throw new LedgerError('ledger.splits_mismatch', 'At least one split is required');
  const splitTotal = input.splits.reduce((a, s) => a + s.amount, 0n);
  if (splitTotal !== input.amount) {
    throw new LedgerError(
      'ledger.splits_mismatch',
      `Splits sum to ${splitTotal} but the transaction amount is ${input.amount}`,
    );
  }

  const payer = resolver.entity(input.account.entityId);
  const kind = input.kind ?? 'standard';
  const main = new EntryWriter(payer);
  const others = new Map<string, EntryWriter>();
  const rate = input.fxRate;

  main.add(
    input.account,
    input.amount,
    toFunctional(input.amount, input.account.currency, payer.functionalCurrency, rate),
    input.accountTags,
    rate,
  );

  for (const split of input.splits) {
    const tags: PostingTags = split;
    if (split.account.entityId === payer.id) {
      // Same entity: the split posts in its own account currency.
      let amount: bigint;
      if (split.account.currency === input.account.currency) amount = -split.amount;
      else if (split.account.currency === payer.functionalCurrency)
        amount = -toFunctional(split.amount, input.account.currency, payer.functionalCurrency, rate);
      else
        throw new LedgerError(
          'ledger.unsupported',
          `Split account currency ${split.account.currency} must match the account or functional currency`,
        );
      const functional =
        split.account.currency === payer.functionalCurrency
          ? amount
          : -toFunctional(split.amount, input.account.currency, payer.functionalCurrency, rate);
      if (amount === 0n && functional === 0n) {
        throw new LedgerError('ledger.zero_posting', 'A split converts to zero in the functional currency');
      }
      main.add(split.account, amount, functional, tags, rate);
      continue;
    }

    // Split for another entity (DE-05): clearing posting here, mirrored entry over there.
    const remote = resolver.entity(split.account.entityId);
    if (
      input.account.currency !== payer.functionalCurrency ||
      remote.functionalCurrency !== payer.functionalCurrency ||
      split.account.currency !== payer.functionalCurrency
    ) {
      throw new LedgerError(
        'ledger.unsupported',
        'Splits across entities currently require one shared currency for the account and both entities',
      );
    }
    const flow = split.amount < 0n ? 'out' : 'in';
    const { local, remote: remoteCounter } = resolver.interEntity(payer.id, remote.id, flow);
    main.add(local, -split.amount, -split.amount, { memo: tags.memo ?? null });
    const writer = others.get(remote.id) ?? new EntryWriter(remote);
    others.set(remote.id, writer);
    writer.add(split.account, -split.amount, -split.amount, tags);
    writer.add(remoteCounter, split.amount, split.amount, { memo: tags.memo ?? null });
  }

  settleResidual(main, resolver, 'fx_rounding');
  return [
    main.build(input.date, kind, input.description),
    ...[...others.values()].map((w) => w.build(input.date, kind, input.description)),
  ];
}

export interface TransferInput {
  readonly date: CalendarDate;
  readonly description: string;
  readonly from: LedgerAccountRef;
  readonly to: LedgerAccountRef;
  /** Positive amount leaving `from`, in `from`'s currency. */
  readonly amountOut: bigint;
  /** Positive amount arriving in `to`, in `to`'s currency. Defaults to `amountOut` (same currency). */
  readonly amountIn?: bigint;
  /** Functional units per 1 unit of `from.currency` / `to.currency`, when they differ from functional. */
  readonly fxRateFrom?: Decimal;
  readonly fxRateTo?: Decimal;
  readonly memberId?: string | null;
}

/**
 * Transfers between accounts (DE-03, TXN-04, CUR-08). Same entity: one entry, never income or expense.
 * Different currencies: both amounts are kept; the functional difference is FX cost/gain (fx_gain_loss).
 * Different entities: one entry per entity through the inter-entity accounts.
 */
export function buildTransferEntries(input: TransferInput, resolver: AccountResolver): JournalEntryDraft[] {
  if (input.amountOut <= 0n) throw new LedgerError('ledger.zero_posting', 'Transfer amount must be positive');
  if (input.from.id === input.to.id) throw new LedgerError('ledger.unsupported', 'Cannot transfer to the same account');
  const amountIn = input.amountIn ?? input.amountOut;
  if (input.amountIn === undefined && input.from.currency !== input.to.currency) {
    throw new LedgerError('ledger.fx_rate_required', 'amountIn is required for a transfer between currencies');
  }
  const tags: PostingTags = { memberId: input.memberId ?? null };
  const fromEntity = resolver.entity(input.from.entityId);

  if (input.from.entityId === input.to.entityId) {
    const w = new EntryWriter(fromEntity);
    const f = fromEntity.functionalCurrency;
    w.add(input.to, amountIn, toFunctional(amountIn, input.to.currency, f, input.fxRateTo), tags, input.fxRateTo);
    w.add(
      input.from,
      -input.amountOut,
      -toFunctional(input.amountOut, input.from.currency, f, input.fxRateFrom),
      tags,
      input.fxRateFrom,
    );
    settleResidual(w, resolver, input.from.currency === input.to.currency ? 'fx_rounding' : 'fx_gain_loss');
    return [w.build(input.date, 'transfer', input.description)];
  }

  const toEntity = resolver.entity(input.to.entityId);
  if (
    input.from.currency !== input.to.currency ||
    input.from.currency !== fromEntity.functionalCurrency ||
    toEntity.functionalCurrency !== fromEntity.functionalCurrency ||
    amountIn !== input.amountOut
  ) {
    throw new LedgerError('ledger.unsupported', 'Transfers across entities currently require one shared currency');
  }
  const { local, remote } = resolver.interEntity(fromEntity.id, toEntity.id, 'out');
  const a = new EntryWriter(fromEntity);
  a.add(local, input.amountOut, input.amountOut, tags);
  a.add(input.from, -input.amountOut, -input.amountOut, tags);
  const b = new EntryWriter(toEntity);
  b.add(input.to, input.amountOut, input.amountOut, tags);
  b.add(remote, -input.amountOut, -input.amountOut, tags);
  return [a.build(input.date, 'transfer', input.description), b.build(input.date, 'transfer', input.description)];
}

/**
 * Opening balance (ACC-05): `balance` is debit-positive, so a checking balance of 1,000 is +1000 and a
 * credit card owing 500 is −500. The counterpart is the entity's opening-balance equity account.
 */
export function buildOpeningBalanceEntry(
  account: LedgerAccountRef,
  balance: bigint,
  date: CalendarDate,
  resolver: AccountResolver,
  fxRate?: Decimal,
): JournalEntryDraft {
  if (balance === 0n) throw new LedgerError('ledger.zero_posting', 'Opening balance is zero; nothing to post');
  const entity = resolver.entity(account.entityId);
  const w = new EntryWriter(entity);
  const functional = toFunctional(balance, account.currency, entity.functionalCurrency, fxRate);
  w.add(account, balance, functional, {}, fxRate);
  const equity = resolver.systemAccount(entity.id, 'opening_balance_equity');
  w.add(equity, -functional, -functional);
  return w.build(date, 'opening_balance', 'Opening balance');
}

/** Reverses an entry (DE-10): same lines with opposite signs, dated `date`. */
export function buildReversal(entry: JournalEntryDraft, date: CalendarDate, description?: string): JournalEntryDraft {
  const reversed: JournalEntryDraft = {
    ...entry,
    entryDate: date,
    kind: 'reversal',
    description: description ?? `Reversal: ${entry.description}`,
    postings: entry.postings.map((p) => ({ ...p, amount: -p.amount, functionalAmount: -p.functionalAmount })),
  };
  validateEntry(reversed);
  return reversed;
}
