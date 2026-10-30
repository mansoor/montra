import type { JournalEntryDraft } from './types.js';

export type LedgerErrorCode =
  | 'ledger.too_few_postings'
  | 'ledger.unbalanced'
  | 'ledger.zero_posting'
  | 'ledger.cross_entity_posting'
  | 'ledger.currency_mismatch'
  | 'ledger.splits_mismatch'
  | 'ledger.fx_rate_required'
  | 'ledger.unsupported';

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Checks the invariants the database also enforces (DE-01, CUR-07): at least two postings, no zero
 * lines, every posting on an account of the entry's entity, and functional amounts summing to zero.
 */
export function validateEntry(entry: JournalEntryDraft): void {
  if (entry.postings.length < 2) {
    throw new LedgerError('ledger.too_few_postings', 'A journal entry needs at least two postings');
  }
  let total = 0n;
  for (const p of entry.postings) {
    if (p.amount === 0n && p.functionalAmount === 0n) {
      throw new LedgerError('ledger.zero_posting', `Posting ${p.lineNo} has a zero amount`);
    }
    if (p.accountEntityId !== entry.entityId) {
      throw new LedgerError(
        'ledger.cross_entity_posting',
        `Posting ${p.lineNo} targets another entity's account`,
      );
    }
    if (p.currency === entry.functionalCurrency && p.amount !== p.functionalAmount) {
      throw new LedgerError(
        'ledger.currency_mismatch',
        `Posting ${p.lineNo} is in the functional currency but its functional amount differs`,
      );
    }
    if (p.amount !== 0n && p.functionalAmount !== 0n && p.amount > 0n !== p.functionalAmount > 0n) {
      throw new LedgerError('ledger.currency_mismatch', `Posting ${p.lineNo} changes sign on conversion`);
    }
    total += p.functionalAmount;
  }
  if (total !== 0n) {
    throw new LedgerError('ledger.unbalanced', `Debits and credits differ by ${total} minor units`);
  }
}

/** Sum of debits (positive functional amounts), i.e. the entry total shown in journal views. */
export const entryTotal = (entry: JournalEntryDraft): bigint =>
  entry.postings.reduce((acc, p) => (p.functionalAmount > 0n ? acc + p.functionalAmount : acc), 0n);
