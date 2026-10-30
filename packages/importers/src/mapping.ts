import type { DateFormatId } from './dates.js';
import type { DecimalSeparator } from './amounts.js';

/**
 * How to read a statement grid (IMP-03/04). Saved as an import profile and reused by fingerprint.
 * Column indexes are 0-based within the sheet.
 */
export interface ColumnMapping {
  sheet?: string;
  /** Index of the header row; null when the file has no header. Data starts after it (or at `dataStart`). */
  headerRow: number | null;
  dataStart: number;
  date: number;
  dateFormat: DateFormatId;
  /** One or more columns joined with " · " to form the description (e.g. Buchungstext + Verwendungszweck). */
  description: number[];
  payee?: number;
  /** Either one signed amount column … */
  amount?: number;
  /** … or separate debit (money out) and credit (money in) columns. */
  debit?: number;
  credit?: number;
  /** A column saying whether an unsigned amount is a debit or a credit (e.g. Mint's "Transaction Type"). */
  direction?: { column: number; debitValues: string[] };
  /**
   * 'normal': positive = money into the account. 'inverted': positive = money out (typical for card exports
   * that list purchases as positive numbers).
   */
  sign: 'normal' | 'inverted';
  balance?: number;
  category?: number;
  reference?: number;
  /** Rows whose first cells match one of these (case-insensitive) are skipped (totals, footers). */
  skipPatterns?: string[];
  /** Only import rows whose `filter.column` equals one of `filter.values` (multi-account app exports). */
  filter?: { column: number; values: string[] };
  decimal: DecimalSeparator;
}

export type MappingSource = 'profile' | 'reference' | 'heuristic' | 'user';

export interface MappingProposal {
  mapping: ColumnMapping;
  /** 0..1; below 0.75 the UI asks the user to confirm the mapping. */
  confidence: number;
  source: MappingSource;
  warnings: string[];
  header: string[] | null;
}

export const NEEDS_CONFIRMATION_BELOW = 0.75;
