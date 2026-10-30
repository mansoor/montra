/**
 * Turns a stored TransactionSpec into journal entries and applies edits under the lock rules of design 04 §2.3
 * (DE-08..10): unprotected entries are rewritten in place; reconciled entries in an open period get an
 * adjustment on the original date; entries in a closed period are reversed in the first open period.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import {
  addDays,
  asCurrencyCode,
  buildAdjustment,
  buildReversal,
  buildTransactionEntries,
  buildTransferEntries,
  calendarDate,
  compareDates,
  isBalanceSheet,
  type CalendarDate,
  type JournalEntryDraft,
  type SplitInput,
} from '@montra/domain';
import { AppError, unprocessable } from '../common/errors.js';
import { LedgerService } from '../ledger/ledger.service.js';

export interface SplitSpec {
  accountId: string;
  amount: string;
  memberId: string | null;
  memo?: string | null;
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
    }
  | {
      type: 'transfer';
      fromAccountId: string;
      toAccountId: string;
      amount: string;
      currency: string;
      description: string;
    };

export interface BuiltTransaction {
  drafts: JournalEntryDraft[];
  primaryEntityId: string;
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

@Injectable()
export class TransactionPoster {
  constructor(@Inject(LedgerService) private readonly ledger: LedgerService) {}

  /** Builds the journal entries for a spec (no writes besides any missing inter-entity accounts). */
  async build(trx: Trx, ctx: Ctx, spec: TransactionSpec, date: CalendarDate): Promise<BuiltTransaction> {
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
      if (from.currency !== to.currency) {
        throw unprocessable(
          'fx.rate_required',
          'Transfers between currencies arrive with FX support (Phase 5)',
        );
      }
      const amountOut = BigInt(spec.amount);
      if (amountOut <= 0n) throw unprocessable('amount.not_positive', 'Transfer amount must be positive');
      const resolver = await this.ledger.resolver(trx, ctx.workspaceId, [[from.entityId, to.entityId]]);
      return {
        drafts: buildTransferEntries({ date, description: spec.description, from, to, amountOut }, resolver),
        primaryEntityId: from.entityId,
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
    if (account.currency !== (await this.functionalCurrency(trx, account.entityId))) {
      throw unprocessable('fx.rate_required', 'Foreign-currency accounts arrive with FX support (Phase 5)');
    }
    const splits: SplitInput[] = [];
    for (const s of spec.splits) {
      const ref = await this.ledger.accountRef(trx, ctx.workspaceId, s.accountId);
      if (ref.id === account.id)
        throw unprocessable('split.same_account', 'A split cannot target the paying account');
      splits.push({ account: ref, amount: BigInt(s.amount), memberId: s.memberId, memo: s.memo ?? null });
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
          splits,
          accountTags: { memberId: spec.memberId },
        },
        resolver,
      ),
      primaryEntityId: account.entityId,
    };
  }

  /** Category used when nothing else is known: the entity's uncategorized income or expense account. */
  async uncategorizedAccount(trx: Trx, ctx: Ctx, accountId: string, amount: bigint): Promise<string> {
    const account = await this.ledger.accountRef(trx, ctx.workspaceId, accountId);
    const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
    return resolver.systemAccount(
      account.entityId,
      amount < 0n ? 'uncategorized_expense' : 'uncategorized_income',
    ).id;
  }

  /** Replaces a transaction's ledger impact with `next`, entity by entity, following the lock rules. */
  async repost(trx: Trx, ctx: Ctx, transactionId: string, next: JournalEntryDraft[]): Promise<void> {
    const bookings = await this.loadBookings(trx, ctx, transactionId);
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
    await this.ledger.post(trx, ctx, transactionId, writes);
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
    const e = await trx
      .selectFrom('app.entity')
      .select('functional_currency')
      .where('id', '=', entityId)
      .executeTakeFirstOrThrow();
    return e.functional_currency;
  }

  private async lockedThrough(trx: Trx, ctx: Ctx, entityId: string): Promise<CalendarDate | null> {
    const { rows } = await sql<{
      d: string | null;
    }>`select app.locked_through(${ctx.workspaceId}, ${entityId}) as d`.execute(trx);
    return rows[0]?.d ? calendarDate(rows[0].d) : null;
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
