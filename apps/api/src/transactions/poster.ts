/**
 * Turns a stored TransactionSpec into journal entries and applies edits under the lock rules of design 04 §2.3
 * (DE-08..10): unprotected entries are rewritten in place; reconciled entries in an open period get an
 * adjustment on the original date; entries in a closed period are reversed in the first open period.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  abs,
  addDays,
  asCurrencyCode,
  buildAdjustment,
  buildReversal,
  buildTransactionEntries,
  buildTransferEntries,
  calendarDate,
  FOLLOWING_ROLES,
  rebookStandalone,
  rebookTransaction,
  compareDates,
  decimalToString,
  impliedRate,
  isBalanceSheet,
  minorUnits,
  parseDecimal,
  type CalendarDate,
  type CarryingBalance,
  type Decimal,
  type JournalEntryDraft,
  type JournalKind,
  type LedgerAccountRef,
  type RebookEntity,
  type RebookLine,
  type SplitInput,
  type SystemRole,
} from '@montra/domain';
import { AppError, unprocessable } from '../common/errors.js';
import { FxRatesService } from '../fx/fx.service.js';
import { LedgerService } from '../ledger/ledger.service.js';

export interface SplitSpec {
  accountId: string;
  amount: string;
  memberId: string | null;
  memo?: string | null;
  /** RNT-06: which property and unit this part belongs to. */
  propertyId?: string | null;
  unitId?: string | null;
}

export type TransactionSpec =
  | {
      type: 'standard';
      accountId: string;
      amount: string;
      currency: string;
      description: string;
      memberId: string | null;
      /** True when the split went to the uncategorized system account (review queue). */
      uncategorized: boolean;
      splits: SplitSpec[];
      /** Foreign-currency account: a rate the user entered (CUR-05). Absent: the day's reference rate. */
      fxRate?: string;
      /** Set when a payslip owns this transaction (ADR-0016): change it through the payslip, not here. */
      payslipId?: string;
      /** The same for an invoice or bill this pays (ADR-0017). */
      invoiceId?: string;
      billId?: string;
      /** The same for rent, a security deposit or a mortgage payment (ADR-0018). */
      leaseId?: string;
      depositLeaseId?: string;
      loanId?: string;
      /** The payslip's employer: this deposit is the pay its expected income is waiting for (PAY-07). */
      employerId?: string;
      /**
       * A purchase in another currency on a home-currency account (CUR-03): the original amount (signed like
       * `amount`), the fee included in `amount` (its split posts to Bank fees) and a rate override.
       */
      foreign?: ForeignSpec;
    }
  | {
      type: 'transfer';
      fromAccountId: string;
      toAccountId: string;
      amount: string;
      currency: string;
      description: string;
      /** Amount arriving in the destination account, when its currency differs (CUR-08). */
      amountIn?: string;
      /** Rate overrides for foreign-currency legs. */
      fxRateFrom?: string;
      fxRateTo?: string;
    };

export type TransactionOwner = 'payslip' | 'invoice' | 'bill' | 'lease' | 'security_deposit' | 'loan';

const OWNER_FIELDS: readonly (readonly [string, TransactionOwner])[] = [
  ['payslipId', 'payslip'],
  ['invoiceId', 'invoice'],
  ['billId', 'bill'],
  ['leaseId', 'lease'],
  ['depositLeaseId', 'security_deposit'],
  ['loanId', 'loan'],
];

/** What owns this transaction, if anything (ADR-0016..18). Its ledger side changes only through the owner. */
export function ownerOf(spec: unknown): TransactionOwner | null {
  const s = spec as Record<string, unknown> | null | undefined;
  return OWNER_FIELDS.find(([field]) => s?.[field])?.[1] ?? null;
}

const OWNER_WORDS: Record<TransactionOwner, string> = {
  payslip: 'a payslip',
  invoice: 'an invoice',
  bill: 'a bill',
  lease: 'a lease',
  security_deposit: 'a lease',
  loan: 'a mortgage',
};

export function assertNotOwned(spec: unknown): void {
  const owner = ownerOf(spec);
  if (owner) {
    const word = OWNER_WORDS[owner];
    throw unprocessable(
      `${owner}.managed`,
      `This comes from ${word}: change it on ${word.replace(/^an? /, 'the ')}`,
    );
  }
}

export interface ForeignSpec {
  amount: string;
  currency: string;
  fee: string | null;
  rate: string | null;
}

/** What the transaction stores in its FX columns (CUR-03/05, ADR-0014); null clears them. */
export interface TransactionFx {
  originalAmount: string;
  originalCurrency: string;
  /** Functional (home) units per original unit. */
  rate: string;
  source: 'implied' | 'reference' | 'user';
}

export interface BuiltTransaction {
  drafts: JournalEntryDraft[];
  primaryEntityId: string;
  fx: TransactionFx | null;
}

type Ctx = { workspaceId: string; userId: string };

/** All entries of one transaction for one entity, collapsed into their net effect. */
interface EntityBooking {
  entityId: string;
  entryIds: string[];
  /** Net postings of all entries (original, adjustments, reversals); null when they cancel out. */
  effective: JournalEntryDraft | null;
  earliestDate: CalendarDate;
  locked: boolean;
  reconciledLines: { accountId: string; amount: bigint }[];
}

const collapse = (draft: JournalEntryDraft): JournalEntryDraft | null =>
  buildAdjustment({ ...draft, postings: [] }, draft, draft.entryDate, draft.description);

export class ReconciledError extends AppError {
  constructor() {
    super(
      409,
      'transaction.reconciled',
      'This transaction is reconciled. Its cash amount, account and date can only change after un-reconciling it.',
    );
  }
}

/** The same check in SQL, for a transaction aliased `t`: lines free to be linked or changed in bulk. */
export const NOT_OWNED = sql.raw(OWNER_FIELDS.map(([field]) => `t.spec->>'${field}' is null`).join(' and '));

@Injectable()
export class TransactionPoster {
  constructor(
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(FxRatesService) private readonly fx: FxRatesService,
  ) {}

  /**
   * Builds the journal entries for a spec (no writes besides any missing inter-entity accounts).
   * Foreign-currency accounts are valued at the day's reference rate (or the user's), and money leaving them
   * at their carrying value (ADR-0010); `transactionId` keeps a re-posted transaction out of its own
   * carrying balance.
   */
  async build(
    trx: Trx,
    ctx: Ctx,
    spec: TransactionSpec,
    date: CalendarDate,
    transactionId?: string,
  ): Promise<BuiltTransaction> {
    assertNotOwned(spec);
    if (spec.type === 'transfer') {
      const from = await this.ledger.accountRef(trx, ctx.workspaceId, spec.fromAccountId);
      const to = await this.ledger.accountRef(trx, ctx.workspaceId, spec.toAccountId);
      if (!isBalanceSheet(from.type) || !isBalanceSheet(to.type)) {
        throw unprocessable(
          'account.not_a_bank_account',
          'Transfers move money between bank, card or asset accounts',
        );
      }
      if (spec.currency !== from.currency)
        throw unprocessable('currency.mismatch', `Amount currency must be ${from.currency}`);
      const amountOut = BigInt(spec.amount);
      if (amountOut <= 0n) throw unprocessable('amount.not_positive', 'Transfer amount must be positive');
      let amountIn = amountOut;
      if (from.currency !== to.currency) {
        if (!spec.amountIn) {
          throw unprocessable(
            'fx.amount_in_required',
            `Enter the amount that arrived in ${to.currency} for a transfer between currencies`,
          );
        }
        amountIn = BigInt(spec.amountIn);
        if (amountIn <= 0n)
          throw unprocessable('amount.not_positive', 'The amount received must be positive');
      }
      const functional = await this.functionalCurrency(trx, from.entityId);
      const resolver = await this.ledger.resolver(trx, ctx.workspaceId, [[from.entityId, to.entityId]]);
      // CUR-08: a leg in the functional currency fixes the other leg's rate (implied by the two amounts);
      // two foreign legs use the day's reference rates. The gap posts to fx_gain_loss.
      const legRate = async (
        leg: LedgerAccountRef,
        other: LedgerAccountRef,
        legAmount: bigint,
        otherAmount: bigint,
        override: string | undefined,
      ): Promise<Decimal | undefined> => {
        if (leg.currency === functional) return undefined;
        if (override) return parseDecimal(override);
        if (other.currency === functional) {
          return impliedRate(otherAmount, minorUnits(other.currency), legAmount, minorUnits(leg.currency));
        }
        return this.referenceRate(trx, leg.currency, functional, date);
      };
      return {
        drafts: buildTransferEntries(
          {
            date,
            description: spec.description,
            from,
            to,
            amountOut,
            ...(from.currency !== to.currency ? { amountIn } : {}),
            fxRateFrom: await legRate(from, to, amountOut, amountIn, spec.fxRateFrom),
            fxRateTo: await legRate(to, from, amountIn, amountOut, spec.fxRateTo),
            carryingFrom: await this.carryingOf(trx, ctx, from, functional, date, transactionId),
            carryingTo: await this.carryingOf(trx, ctx, to, functional, date, transactionId),
          },
          resolver,
        ),
        primaryEntityId: from.entityId,
        fx: null,
      };
    }

    const account = await this.ledger.accountRef(trx, ctx.workspaceId, spec.accountId);
    if (!isBalanceSheet(account.type)) {
      throw unprocessable(
        'account.not_a_bank_account',
        'Transactions are recorded against a bank, card or asset account',
      );
    }
    if (spec.currency !== account.currency)
      throw unprocessable('currency.mismatch', `Amount currency must be ${account.currency}`);
    const functional = await this.functionalCurrency(trx, account.entityId);
    let fxRate: Decimal | undefined;
    let fx: TransactionFx | null = null;
    if (account.currency !== functional) {
      // CUR-07: a foreign-currency account posts at the user's rate or the day's reference rate.
      if (spec.foreign) {
        throw unprocessable(
          'fx.foreign_on_foreign_account',
          'A foreign-currency account records its own currency; enter the amount in that currency',
        );
      }
      fxRate = spec.fxRate
        ? parseDecimal(spec.fxRate)
        : await this.referenceRate(trx, account.currency, functional, date);
      fx = {
        originalAmount: spec.amount,
        originalCurrency: account.currency,
        rate: trimRate(decimalToString(fxRate)),
        source: spec.fxRate ? 'user' : 'reference',
      };
    } else if (spec.fxRate) {
      throw unprocessable('fx.not_foreign', `The account is in ${functional}; there is no rate to set`);
    } else if (spec.foreign) {
      // CUR-03: the postings stay in the account currency; the transaction keeps the original amount and the
      // rate implied by the charge without the fee.
      const charged = abs(BigInt(spec.amount)) - BigInt(spec.foreign.fee ?? '0');
      const original = abs(BigInt(spec.foreign.amount));
      fx = {
        originalAmount: spec.foreign.amount,
        originalCurrency: spec.foreign.currency,
        rate:
          spec.foreign.rate ??
          trimRate(
            decimalToString(
              impliedRate(
                charged,
                minorUnits(account.currency),
                original,
                minorUnits(asCurrencyCode(spec.foreign.currency)),
              ),
            ),
          ),
        source: spec.foreign.rate ? 'user' : 'implied',
      };
    }
    const splits: SplitInput[] = [];
    for (const s of spec.splits) {
      const ref = await this.ledger.accountRef(trx, ctx.workspaceId, s.accountId);
      if (ref.id === account.id)
        throw unprocessable('split.same_account', 'A split cannot target the paying account');
      splits.push({
        account: ref,
        amount: BigInt(s.amount),
        memberId: s.memberId,
        memo: s.memo ?? null,
        propertyId: s.propertyId ?? null,
        unitId: s.unitId ?? null,
      });
    }
    const resolver = await this.ledger.resolver(
      trx,
      ctx.workspaceId,
      splits.map((s) => [account.entityId, s.account.entityId] as [string, string]),
    );
    return {
      drafts: buildTransactionEntries(
        {
          date,
          description: spec.description,
          account,
          amount: BigInt(spec.amount),
          fxRate,
          carrying: await this.carryingOf(trx, ctx, account, functional, date, transactionId),
          splits,
          accountTags: { memberId: spec.memberId },
        },
        resolver,
      ),
      primaryEntityId: account.entityId,
      fx,
    };
  }

  /** Posts a built transaction (see `repost`) and records its FX columns (CUR-03/05). */
  async post(
    trx: Trx,
    ctx: Ctx,
    transactionId: string,
    built: BuiltTransaction,
    opts: { fresh?: boolean; clearedAccountId?: string } = {},
  ): Promise<void> {
    await this.repost(trx, ctx, transactionId, built.drafts, opts);
    // New rows start with empty FX columns; only write when there is something to record or clear.
    if (opts.fresh && !built.fx) return;
    await trx
      .updateTable('app.transaction')
      .set({
        original_amount_minor: built.fx ? built.fx.originalAmount : null,
        original_currency: built.fx?.originalCurrency ?? null,
        fx_rate: built.fx?.rate ?? null,
        fx_rate_source: built.fx?.source ?? null,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .execute();
  }

  /** The day's reference rate (CUR-05), or a problem asking the user for one. */
  private referenceRate(trx: Trx, from: string, to: string, date: CalendarDate): Promise<Decimal> {
    return this.fx.requireRate(trx, from, to, date);
  }

  /**
   * A foreign-currency account's balance before this transaction (ADR-0010 carrying value): its postings
   * up to `date`, without the transaction's own entries. Same-day postings all count as earlier.
   */
  private async carryingOf(
    trx: Trx,
    ctx: Ctx,
    account: LedgerAccountRef,
    functional: string,
    date: CalendarDate,
    transactionId: string | undefined,
  ): Promise<CarryingBalance | undefined> {
    if (account.currency === functional) return undefined;
    let q = trx
      .selectFrom('app.posting as p')
      .innerJoin('app.journal_entry as je', (j) =>
        j.onRef('je.workspace_id', '=', 'p.workspace_id').onRef('je.id', '=', 'p.journal_entry_id'),
      )
      .select([
        sql<string>`coalesce(sum(p.amount_minor), 0)`.as('foreign'),
        sql<string>`coalesce(sum(p.functional_amount_minor), 0)`.as('functional'),
      ])
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('p.ledger_account_id', '=', account.id)
      .where('p.entry_date', '<=', date);
    if (transactionId)
      q = q.where((eb) =>
        eb.or([eb('je.transaction_id', 'is', null), eb('je.transaction_id', '!=', transactionId)]),
      );
    const row = await q.executeTakeFirstOrThrow();
    return { foreign: BigInt(row.foreign), functional: BigInt(row.functional) };
  }

  /** Category used when nothing else is known: the entity's uncategorized income or expense account. */
  async uncategorizedAccount(trx: Trx, ctx: Ctx, accountId: string, amount: bigint): Promise<string> {
    return this.systemAccountFor(
      trx,
      ctx,
      accountId,
      amount < 0n ? 'uncategorized_expense' : 'uncategorized_income',
    );
  }

  /** A system account (e.g. `bank_fees`, CUR-03) of the entity that owns `accountId`. */
  /**
   * Puts a transaction back as it was before a payslip, invoice or bill took it over. It keeps its statement date, and a
   * statement line stays cleared (DE-08, DE-10).
   */
  async restoreTaken(trx: Trx, ctx: Ctx, transactionId: string, spec: TransactionSpec): Promise<void> {
    const t = await trx
      .updateTable('app.transaction')
      .set({ spec: JSON.stringify(spec) })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .returning(['txn_date', 'source'])
      .executeTakeFirstOrThrow();
    const built = await this.build(trx, ctx, spec, calendarDate(String(t.txn_date)), transactionId);
    await this.post(trx, ctx, transactionId, built, {
      ...(t.source === 'import' && spec.type === 'standard' ? { clearedAccountId: spec.accountId } : {}),
    });
  }

  async systemAccountFor(trx: Trx, ctx: Ctx, accountId: string, role: SystemRole): Promise<string> {
    const account = await this.ledger.accountRef(trx, ctx.workspaceId, accountId);
    const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
    return resolver.systemAccount(account.entityId, role).id;
  }

  /** Replaces a transaction's ledger impact with `next`, entity by entity, following the lock rules. */
  async repost(
    trx: Trx,
    ctx: Ctx,
    transactionId: string,
    next: JournalEntryDraft[],
    opts: { fresh?: boolean; clearedAccountId?: string } = {},
  ): Promise<void> {
    // A brand-new transaction has nothing booked yet; skip the lookup (bulk imports post thousands).
    const bookings = opts.fresh ? [] : await this.loadBookings(trx, ctx, transactionId);
    const entities = new Set([...bookings.map((b) => b.entityId), ...next.map((d) => d.entityId)]);
    const writes: JournalEntryDraft[] = [];
    for (const entityId of entities) {
      const booking = bookings.find((b) => b.entityId === entityId);
      const fresh = next.filter((d) => d.entityId === entityId);
      const lockDate = await this.lockedThrough(trx, ctx, entityId);
      const isClosed = (date: CalendarDate) => lockDate !== null && compareDates(date, lockDate) <= 0;
      const firstOpen = lockDate ? addDays(lockDate, 1) : null;
      const movedOutOfClosed = (d: JournalEntryDraft) =>
        isClosed(d.entryDate) ? { ...d, entryDate: firstOpen! } : d;

      const rejectClosed = (d: JournalEntryDraft) => {
        if (isClosed(d.entryDate)) {
          throw new AppError(
            409,
            'period.locked',
            `The books are closed through ${lockDate}; choose a later date`,
          );
        }
        return d;
      };
      if (!booking || (!booking.locked && !isClosed(booking.earliestDate))) {
        if (booking) await this.deleteEntries(trx, ctx, booking.entryIds);
        writes.push(...fresh.map(rejectClosed));
        continue;
      }
      if (isClosed(booking.earliestDate)) {
        // Closed period: reverse what is booked and post the new version in the first open period.
        if (booking.effective) writes.push(buildReversal(booking.effective, firstOpen!));
        writes.push(...fresh.map(movedOutOfClosed));
        continue;
      }
      // Reconciled, open period: reconciled lines must survive; post only the difference on the original date.
      const replacement = fresh[0];
      if (replacement && replacement.entryDate !== booking.earliestDate) throw new ReconciledError();
      for (const line of booking.reconciledLines) {
        const kept = replacement?.postings.some(
          (p) => p.accountId === line.accountId && p.amount === line.amount,
        );
        if (!kept) throw new ReconciledError();
      }
      if (fresh.length > 1)
        throw unprocessable('ledger.unsupported', 'Unexpected multiple entries for one entity');
      const before = booking.effective ?? { ...replacement!, postings: [] };
      const adjustment = replacement
        ? buildAdjustment(
            before,
            replacement,
            booking.earliestDate,
            `Reclassified: ${replacement.description}`,
          )
        : null;
      if (adjustment) writes.push(adjustment);
    }
    await this.ledger.post(trx, ctx, transactionId, writes, { clearedAccountId: opts.clearedAccountId });
  }

  /** Removes or reverses all entries (void, DE-10). Reconciled entries in open periods block the void. */
  async unpost(trx: Trx, ctx: Ctx, transactionId: string): Promise<'removed' | 'reversed'> {
    const bookings = await this.loadBookings(trx, ctx, transactionId);
    let outcome: 'removed' | 'reversed' = 'removed';
    const reversals: JournalEntryDraft[] = [];
    for (const b of bookings) {
      const lockDate = await this.lockedThrough(trx, ctx, b.entityId);
      if (lockDate !== null && compareDates(b.earliestDate, lockDate) <= 0) {
        if (b.effective) reversals.push(buildReversal(b.effective, addDays(lockDate, 1)));
        outcome = 'reversed';
      } else if (b.locked) {
        throw new ReconciledError();
      } else {
        await this.deleteEntries(trx, ctx, b.entryIds);
      }
    }
    if (reversals.length) await this.ledger.post(trx, ctx, transactionId, reversals);
    return outcome;
  }

  /**
   * ADR-0033: everything booked on `accountId`, re-booked as if the account had always been in `toEntityId`'s books.
   * The caller has checked that nothing is in a closed period and the books share a currency. Reconciled lines are
   * rewritten under the audited locked-edit setting and keep their state; before anything is written, each
   * transaction's lines (settling lines aside) must total exactly what they did, or nothing changes.
   */
  async rebookAccount(
    trx: Trx,
    ctx: Ctx,
    accountId: string,
    fromEntityId: string,
    toEntityId: string,
  ): Promise<{ transactions: number; entries: number }> {
    const touched = await trx
      .selectFrom('app.journal_entry as je')
      .innerJoin('app.posting as p', (j) =>
        j.onRef('p.workspace_id', '=', 'je.workspace_id').onRef('p.journal_entry_id', '=', 'je.id'),
      )
      .select(['je.id', 'je.transaction_id'])
      .distinct()
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('p.ledger_account_id', '=', accountId)
      .execute();
    const txIds = [...new Set(touched.map((t) => t.transaction_id).filter((t): t is string => t !== null))];
    const standaloneIds = touched.filter((t) => t.transaction_id === null).map((t) => t.id);

    // Every entry being rewritten, with its postings and their accounts' roles.
    const entries = await trx
      .selectFrom('app.journal_entry')
      .select([
        'id',
        'transaction_id',
        'entity_id',
        'entry_date',
        'kind',
        'description',
        'restricted',
        'restricted_member_id',
        'posted_at',
      ])
      .where('workspace_id', '=', ctx.workspaceId)
      .where((eb) =>
        eb.or([
          ...(txIds.length ? [eb('transaction_id', 'in', txIds)] : []),
          ...(standaloneIds.length ? [eb('id', 'in', standaloneIds)] : []),
          eb.val(false),
        ]),
      )
      .orderBy('posted_at')
      .execute();
    const entryIds = entries.map((e) => e.id);
    const postings = entryIds.length
      ? await trx
          .selectFrom('app.posting as p')
          .innerJoin('app.ledger_account as a', 'a.id', 'p.ledger_account_id')
          .select([
            'p.journal_entry_id',
            'p.ledger_account_id',
            'p.amount_minor',
            'p.currency',
            'p.functional_amount_minor',
            'p.fx_rate',
            'p.member_id',
            'p.property_id',
            'p.unit_id',
            'p.memo',
            'p.line_no',
            'p.cleared',
            'p.reconciliation_id',
            'a.system_role',
            'a.counterparty_entity_id',
            'a.entity_id as account_entity_id',
          ])
          .where('p.workspace_id', '=', ctx.workspaceId)
          .where('p.journal_entry_id', 'in', entryIds)
          .orderBy('p.line_no')
          .execute()
      : [];
    const roleOf = new Map(
      postings.map((p) => [
        p.ledger_account_id,
        {
          role: (p.system_role as SystemRole | null) ?? null,
          counterparty: p.counterparty_entity_id,
          entityId: p.account_entity_id,
        },
      ]),
    );
    // A line's cleared state is kept per transaction and account: reconciled wins, then cleared.
    const rank = { uncleared: 0, cleared: 1, reconciled: 2 } as const;
    const clearedOf = new Map<
      string,
      { cleared: 'uncleared' | 'cleared' | 'reconciled'; rec: string | null }
    >();
    const entryTx = new Map(entries.map((e) => [e.id, e.transaction_id ?? `entry:${e.id}`]));
    for (const p of postings) {
      const k = `${entryTx.get(p.journal_entry_id)}|${p.ledger_account_id}`;
      const prev = clearedOf.get(k);
      if (!prev || rank[p.cleared] > rank[prev.cleared])
        clearedOf.set(k, { cleared: p.cleared, rec: p.reconciliation_id });
    }

    const specs = txIds.length
      ? await trx
          .selectFrom('app.transaction')
          .select(['id', 'spec'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', txIds)
          .execute()
      : [];
    const mainAccount = (spec: unknown): string | null => {
      const s = spec as { type?: string; accountId?: string; fromAccountId?: string } | null;
      return (s?.type === 'transfer' ? s.fromAccountId : s?.accountId) ?? null;
    };
    const plans = new Map<string, { hub: string; follows: boolean; spec: unknown }>();
    for (const t of specs) {
      const main = mainAccount(t.spec);
      const follows = main === accountId;
      let hub = toEntityId;
      if (!follows && main) {
        hub =
          roleOf.get(main)?.entityId ?? (await this.ledger.accountRef(trx, ctx.workspaceId, main)).entityId;
      }
      plans.set(t.id, { hub, follows, spec: t.spec });
    }

    const pairs: [string, string][] = [];
    for (const e of entries) {
      const plan = e.transaction_id ? plans.get(e.transaction_id) : undefined;
      if (plan) pairs.push([plan.hub, e.entity_id], [plan.hub, toEntityId]);
    }
    const resolver = await this.ledger.resolver(trx, ctx.workspaceId, pairs);

    const lineOf = (p: (typeof postings)[number]): RebookLine => ({
      lineNo: p.line_no,
      accountId: p.ledger_account_id,
      accountEntityId: p.account_entity_id,
      currency: asCurrencyCode(p.currency),
      amount: BigInt(p.amount_minor),
      functionalAmount: BigInt(p.functional_amount_minor),
      fxRate: p.fx_rate,
      memberId: p.member_id,
      propertyId: p.property_id,
      unitId: p.unit_id,
      memo: p.memo,
      role: (p.system_role as SystemRole | null) ?? null,
      counterpartyEntityId: p.counterparty_entity_id,
    });

    // Plan everything before writing anything.
    const written: { transactionId: string | null; drafts: JournalEntryDraft[] }[] = [];
    const remapped = new Map<string, Map<string, string>>(); // per transaction: old following account → new
    for (const txId of txIds) {
      const plan = plans.get(txId)!;
      const bookings = await this.loadBookings(trx, ctx, txId);
      const rebookEntities: RebookEntity[] = bookings.map((b) => {
        const first = entries.find((e) => e.transaction_id === txId && e.entity_id === b.entityId)!;
        const lines = (b.effective?.postings ?? []).map((l) => ({
          ...l,
          role: roleOf.get(l.accountId)?.role ?? null,
          counterpartyEntityId: roleOf.get(l.accountId)?.counterparty ?? null,
        }));
        return {
          entityId: b.entityId,
          functionalCurrency:
            b.effective?.functionalCurrency ?? resolver.entity(b.entityId).functionalCurrency,
          entryDate: b.earliestDate,
          kind: first.kind as JournalKind,
          description: first.description,
          restricted: first.restricted,
          restrictedMemberId: first.restricted_member_id,
          lines,
        };
      });
      const drafts = rebookTransaction(
        {
          bookings: rebookEntities,
          accountId,
          fromEntityId,
          toEntityId,
          hubEntityId: plan.hub,
          follows: plan.follows,
        },
        resolver,
      );
      const map = new Map<string, string>();
      if (plan.follows) {
        for (const b of rebookEntities)
          for (const l of b.lines)
            if (b.entityId === fromEntityId && l.role && FOLLOWING_ROLES.has(l.role))
              map.set(l.accountId, resolver.systemAccount(toEntityId, l.role).id);
      }
      // Settling accounts the resolver just created (a first owner draw) aren't known yet: learn their roles.
      const unknown = drafts
        .flatMap((d) => d.postings.map((p) => p.accountId))
        .filter((id) => !roleOf.has(id));
      if (unknown.length) {
        for (const a of await trx
          .selectFrom('app.ledger_account')
          .select(['id', 'system_role', 'counterparty_entity_id', 'entity_id'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', unknown)
          .execute()) {
          roleOf.set(a.id, {
            role: (a.system_role as SystemRole | null) ?? null,
            counterparty: a.counterparty_entity_id,
            entityId: a.entity_id,
          });
        }
      }
      assertSameLines(
        rebookEntities.flatMap((b) => b.lines),
        drafts.flatMap((d) => d.postings),
        map,
        roleOf,
      );
      remapped.set(txId, map);
      written.push({ transactionId: txId, drafts });
    }
    for (const id of standaloneIds) {
      const e = entries.find((x) => x.id === id)!;
      const draft = rebookStandalone(
        {
          entityId: e.entity_id,
          functionalCurrency: resolver.entity(e.entity_id).functionalCurrency,
          entryDate: calendarDate(String(e.entry_date).slice(0, 10)),
          kind: e.kind as JournalKind,
          description: e.description,
          lines: postings.filter((p) => p.journal_entry_id === id).map(lineOf),
        },
        accountId,
        toEntityId,
        resolver,
      );
      if (!draft) {
        throw unprocessable(
          'account.move_manual_journal',
          'A journal written by hand uses this account with something only the old books have',
        );
      }
      written.push({ transactionId: null, drafts: [draft] });
    }

    // Write: the old entries go, the account changes books, the new entries come in with their states.
    await sql`select set_config('app.allow_locked_edit', 'on', true)`.execute(trx);
    await this.deleteEntries(trx, ctx, entryIds);
    await trx
      .updateTable('app.ledger_account')
      .set({ entity_id: toEntityId })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', accountId)
      .execute();
    this.ledger.cacheOf(trx)?.accounts.delete(accountId);
    for (const w of written) {
      const ids = await this.ledger.post(trx, ctx, w.transactionId, w.drafts);
      const key = w.transactionId ?? `entry:${standaloneIds[written.indexOf(w) - txIds.length]}`;
      for (const [i, draft] of w.drafts.entries()) {
        let locked = false;
        for (const p of draft.postings) {
          const state = clearedOf.get(`${key}|${p.accountId}`);
          if (!state || state.cleared === 'uncleared') continue;
          locked ||= state.cleared === 'reconciled';
          await trx
            .updateTable('app.posting')
            .set({ cleared: state.cleared, reconciliation_id: state.rec })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('journal_entry_id', '=', ids[i]!)
            .where('ledger_account_id', '=', p.accountId)
            .execute();
        }
        if (locked) {
          await trx
            .updateTable('app.journal_entry')
            .set({ locked: true })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', ids[i]!)
            .execute();
        }
      }
    }
    // Transactions whose main account moved: their books, and their spec's system splits, follow it.
    for (const txId of txIds) {
      const plan = plans.get(txId)!;
      if (!plan.follows) continue;
      const map = remapped.get(txId)!;
      const spec = plan.spec as { splits?: { accountId: string }[] } | null;
      const next = spec?.splits
        ? {
            ...spec,
            splits: spec.splits.map((s) => ({ ...s, accountId: map.get(s.accountId) ?? s.accountId })),
          }
        : spec;
      await trx
        .updateTable('app.transaction')
        .set({ primary_entity_id: toEntityId, ...(next ? { spec: JSON.stringify(next) } : {}) })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', txId)
        .execute();
    }
    await sql`select app.move_account_read_model(${accountId}::uuid)`.execute(trx);
    await sql`select set_config('app.allow_locked_edit', '', true)`.execute(trx);
    return { transactions: txIds.length, entries: standaloneIds.length };
  }

  /** How a transaction's entries are protected: decides whether undo can remove them (IMP-09, DE-10). */
  async protection(trx: Trx, ctx: Ctx, transactionId: string): Promise<'none' | 'reconciled' | 'closed'> {
    let result: 'none' | 'reconciled' | 'closed' = 'none';
    for (const b of await this.loadBookings(trx, ctx, transactionId)) {
      const lockDate = await this.lockedThrough(trx, ctx, b.entityId);
      if (lockDate !== null && compareDates(b.earliestDate, lockDate) <= 0) result = 'closed';
      else if (b.locked && result === 'none') result = 'reconciled';
    }
    return result;
  }

  async hasEntries(trx: Trx, ctx: Ctx, transactionId: string): Promise<boolean> {
    const row = await trx
      .selectFrom('app.journal_entry')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('transaction_id', '=', transactionId)
      .executeTakeFirst();
    return Boolean(row);
  }

  private async functionalCurrency(trx: Trx, entityId: string): Promise<string> {
    const cached = this.ledger.cacheOf(trx)?.base?.entities.get(entityId);
    if (cached) return cached.functionalCurrency;
    const e = await trx
      .selectFrom('app.entity')
      .select('functional_currency')
      .where('id', '=', entityId)
      .executeTakeFirstOrThrow();
    return e.functional_currency;
  }

  private async lockedThrough(trx: Trx, ctx: Ctx, entityId: string): Promise<CalendarDate | null> {
    const cache = this.ledger.cacheOf(trx);
    if (cache?.locks.has(entityId)) {
      const hit = cache.locks.get(entityId)!;
      return hit ? calendarDate(hit) : null;
    }
    const { rows } = await sql<{
      d: string | null;
    }>`select app.locked_through(${ctx.workspaceId}, ${entityId}) as d`.execute(trx);
    const value = rows[0]?.d ?? null;
    cache?.locks.set(entityId, value);
    return value ? calendarDate(value) : null;
  }

  private async deleteEntries(trx: Trx, ctx: Ctx, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await trx
      .deleteFrom('app.journal_entry')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', ids)
      .execute();
  }

  /** The transaction's entries grouped per entity, with their net effect and protection state. */
  private async loadBookings(trx: Trx, ctx: Ctx, transactionId: string): Promise<EntityBooking[]> {
    const entries = await trx
      .selectFrom('app.journal_entry as je')
      .innerJoin('app.entity as e', 'e.id', 'je.entity_id')
      .select([
        'je.id',
        'je.entity_id',
        'je.entry_date',
        'je.description',
        'je.locked',
        'e.functional_currency',
      ])
      .where('je.workspace_id', '=', ctx.workspaceId)
      .where('je.transaction_id', '=', transactionId)
      .orderBy('je.entry_date')
      .orderBy('je.posted_at')
      .execute();
    if (entries.length === 0) return [];
    const postings = await trx
      .selectFrom('app.posting')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where(
        'journal_entry_id',
        'in',
        entries.map((e) => e.id),
      )
      .orderBy('line_no')
      .execute();
    const bookings = new Map<string, EntityBooking & { lines: JournalEntryDraft['postings'][number][] }>();
    for (const e of entries) {
      const b =
        bookings.get(e.entity_id) ??
        ({
          entityId: e.entity_id,
          entryIds: [],
          effective: null,
          earliestDate: calendarDate(e.entry_date),
          locked: false,
          reconciledLines: [],
          lines: [],
          functional: e.functional_currency,
          description: e.description,
        } as EntityBooking & {
          lines: JournalEntryDraft['postings'][number][];
          functional: string;
          description: string;
        });
      b.entryIds.push(e.id);
      b.locked ||= e.locked;
      for (const p of postings.filter((x) => x.journal_entry_id === e.id)) {
        b.lines.push({
          lineNo: b.lines.length + 1,
          accountId: p.ledger_account_id,
          accountEntityId: p.entity_id,
          currency: asCurrencyCode(p.currency),
          amount: BigInt(p.amount_minor),
          functionalAmount: BigInt(p.functional_amount_minor),
          fxRate: p.fx_rate,
          memberId: p.member_id,
          propertyId: p.property_id,
          unitId: p.unit_id,
          memo: p.memo,
        });
        if (p.cleared === 'reconciled') {
          b.locked = true;
          b.reconciledLines.push({ accountId: p.ledger_account_id, amount: BigInt(p.amount_minor) });
        }
      }
      bookings.set(e.entity_id, b);
    }
    return [...bookings.values()].map((b) => {
      const meta = b as typeof b & { functional: string; description: string };
      const draft: JournalEntryDraft = {
        entityId: b.entityId,
        functionalCurrency: asCurrencyCode(meta.functional),
        entryDate: b.earliestDate,
        kind: 'standard',
        description: meta.description,
        postings: b.lines,
      };
      return {
        entityId: b.entityId,
        entryIds: b.entryIds,
        effective: collapse(draft),
        earliestDate: b.earliestDate,
        locked: b.locked,
        reconciledLines: b.reconciledLines,
      };
    });
  }
}

/** "1.0900000000" → "1.09" for display and storage. */
const trimRate = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

/** Settling lines are redone by a move; everything else must come out to the same totals per account. */
const SETTLING_ROLES: ReadonlySet<string> = new Set([
  'inter_entity_clearing',
  'due_to_entity',
  'due_from_entity',
  'owner_contribution',
  'owner_draw',
]);

/** ADR-0033's safety net: the re-booked lines total, per account, exactly what was booked (system lines mapped). */
function assertSameLines(
  before: readonly { accountId: string; amount: bigint; functionalAmount: bigint }[],
  after: readonly { accountId: string; amount: bigint; functionalAmount: bigint }[],
  remap: ReadonlyMap<string, string>,
  roles: ReadonlyMap<string, { role: SystemRole | null }>,
): void {
  const totals = (lines: typeof before, map: (id: string) => string) => {
    const out = new Map<string, string>();
    const sums = new Map<string, [bigint, bigint]>();
    for (const l of lines) {
      if (SETTLING_ROLES.has(roles.get(l.accountId)?.role ?? '')) continue;
      const k = map(l.accountId);
      const [a, f] = sums.get(k) ?? [0n, 0n];
      sums.set(k, [a + l.amount, f + l.functionalAmount]);
    }
    for (const [k, [a, f]] of sums) if (a !== 0n || f !== 0n) out.set(k, `${a}/${f}`);
    return out;
  };
  const was = totals(before, (id) => remap.get(id) ?? id);
  const is = totals(after, (id) => id);
  const same = was.size === is.size && [...was].every(([k, v]) => is.get(k) === v);
  if (!same) {
    throw new AppError(
      500,
      'ledger.move_changed',
      'Moving the account would have changed its amounts; nothing moved',
    );
  }
}
