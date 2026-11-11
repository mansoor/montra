/**
 * QIF and OFX files aren't grids, so their readers write a grid with fixed columns and a known mapping (ADR-0030).
 * Preview, dedupe, categorization and the switch flow's account split then work as for any CSV.
 */
import { detectDecimalSeparator } from './amounts.js';
import { detectDateFormat } from './dates.js';
import type { FileType } from './decode.js';
import type { Sheet } from './grid.js';
import type { ColumnMapping, MappingProposal } from './mapping.js';

/** Column order of the grid a QIF or OFX reader writes. */
export const FIXED_COLUMNS = [
  'Account',
  'Date',
  'Payee',
  'Memo',
  'Category',
  'Category group',
  'Transfer',
  'Amount',
  'Number',
  'Transaction ID',
] as const;

export const FIXED = {
  account: 0,
  date: 1,
  payee: 2,
  memo: 3,
  category: 4,
  group: 5,
  transfer: 6,
  amount: 7,
  number: 8,
  id: 9,
} as const;

export const isFixedLayout = (fileType: FileType): fileType is 'qif' | 'ofx' =>
  fileType === 'qif' || fileType === 'ofx';

/** Payee Quicken gives an account's first record, which carries its opening balance. */
const OPENING_PAYEES = ['Opening Balance'];

/**
 * What a QIF or OFX mapping always has, whatever columns the user maps: the bank's ids for dedupe, and for QIF the
 * Opening Balance record kept out of the transactions.
 */
export const fixedDefaults = (
  fileType: 'qif' | 'ofx',
): Pick<ColumnMapping, 'externalId' | 'openingPayees'> => ({
  externalId: FIXED.id,
  ...(fileType === 'qif' ? { openingPayees: OPENING_PAYEES } : {}),
});

/** The mapping for a QIF or OFX grid: dates as the file writes them, signs as written. */
export function fixedProposal(
  sheet: Sheet,
  fileType: 'qif' | 'ofx',
  opts: { accountFilter?: string; preferDayFirst?: boolean },
): MappingProposal & {
  templateId: string;
  accounts: string[];
  accountColumn: number | null;
  groupColumn: number | null;
} {
  const data = sheet.rows.slice(1);
  const values = (i: number) => data.map((r) => (r[i] ?? '').trim()).filter(Boolean);
  const accounts = [...new Set(values(FIXED.account))];
  const dates = detectDateFormat(values(FIXED.date), opts.preferDayFirst);
  const mapping: ColumnMapping = {
    headerRow: 0,
    dataStart: 1,
    date: FIXED.date,
    dateFormat: dates?.format ?? 'YYYY-MM-DD',
    description: [FIXED.memo, FIXED.transfer],
    payee: FIXED.payee,
    amount: FIXED.amount,
    sign: 'normal',
    category: FIXED.category,
    reference: FIXED.number,
    decimal: detectDecimalSeparator(values(FIXED.amount)),
    ...fixedDefaults(fileType),
    ...(accounts.length && (opts.accountFilter || accounts.length === 1)
      ? { filter: { column: FIXED.account, values: [opts.accountFilter ?? accounts[0]!] } }
      : {}),
  };
  const warnings = accounts.length > 1 && !opts.accountFilter ? ['multiple_accounts_choose_one'] : [];
  if (dates?.ambiguous) warnings.push('ambiguous_date_format');
  return {
    mapping,
    // Day/month order or the account still to choose is what the mapping step asks about; nothing else is a guess.
    confidence: warnings.length ? 0.7 : 0.98,
    source: 'reference',
    warnings: [...warnings, ...(sheet.warnings ?? [])],
    header: sheet.rows[0] ?? null,
    templateId: fileType,
    accounts,
    accountColumn: accounts.length ? FIXED.account : null,
    groupColumn: fileType === 'qif' ? FIXED.group : null,
  };
}

/** A fixed grid: the header row, then the rows. */
export const fixedSheet = (name: string, rows: string[][], extra: Omit<Sheet, 'name' | 'rows'>): Sheet => ({
  name,
  rows: [[...FIXED_COLUMNS], ...rows],
  ...extra,
});
