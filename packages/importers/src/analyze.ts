/**
 * Entry point used by the import worker: choose a mapping (saved profile → app template → heuristics),
 * parse, and check balances (design 04 §3 steps 2–6).
 */
import type { CalendarDate, CurrencyCode } from '@montra/domain';
import type { FileType } from './decode.js';
import { fingerprint } from './fingerprint.js';
import { FIXED, fixedDefaults, fixedProposal, isFixedLayout } from './fixed-layout.js';
import type { Sheet } from './grid.js';
import { parseAmount } from './amounts.js';
import { parseDate, type StatementDates } from './dates.js';
import { findHeaderRow, inferMapping } from './infer.js';
import type { ColumnMapping, MappingProposal } from './mapping.js';
import { applyMapping, checkBalance, type BalanceCheck, type ParseResult } from './parse.js';
import { findAccountColumn, matchTemplate } from './templates.js';

export interface SavedProfile {
  id: string;
  fingerprint: string;
  mapping: ColumnMapping;
  /**
   * Saved for the account being imported into. Only then does its choice of rows in a multi-account file (`filter`)
   * still hold: for any other account, that choice was someone else's account.
   */
  sameAccount?: boolean;
}

/**
 * A saved profile for this import. Its column choices carry over; its choice of rows in a multi-account file carries
 * over only to the account it was saved for. Elsewhere the asked account (`accountFilter`) replaces it, or the
 * file's accounts are offered again.
 */
function fromProfile(
  sheet: Sheet,
  saved: SavedProfile,
  header: string[] | null,
  accountFilter: string | undefined,
): Analysis['proposal'] {
  const base = {
    confidence: 1,
    source: 'profile' as const,
    warnings: [] as string[],
    header,
    profileId: saved.id,
  };
  const { filter, ...rest } = saved.mapping;
  if (!filter) return { ...base, mapping: saved.mapping };
  const column = filter.column;
  const accounts = [
    ...new Set(
      sheet.rows
        .slice(saved.mapping.dataStart)
        .map((r) => (r[column] ?? '').trim())
        .filter(Boolean),
    ),
  ];
  const listed = { accounts, accountColumn: column };
  if (accountFilter)
    return { ...base, ...listed, mapping: { ...rest, filter: { column, values: [accountFilter] } } };
  if (saved.sameAccount) return { ...base, ...listed, mapping: saved.mapping };
  if (accounts.length === 1)
    return { ...base, ...listed, mapping: { ...rest, filter: { column, values: accounts } } };
  return { ...base, ...listed, mapping: rest, confidence: 0.7, warnings: ['multiple_accounts_choose_one'] };
}

export interface AnalyzeOptions {
  fileType: FileType;
  currency: CurrencyCode;
  accountType: 'asset' | 'liability';
  preferDayFirst?: boolean;
  profiles?: readonly SavedProfile[];
  /** Account value to keep in multi-account app exports. */
  accountFilter?: string;
  /** Statement balances from the document itself (PDF statements), overriding what the grid shows. */
  statement?: {
    opening?: bigint | null;
    closing?: bigint | null;
    periodStart?: CalendarDate | null;
    periodEnd?: CalendarDate | null;
  };
  /**
   * The day the file was uploaded: when the document states no period, dates printed without a year (`10/02`) take
   * the most recent year that doesn't put them after it.
   */
  referenceDate?: CalendarDate | null;
}

/**
 * Where a statement's dates fall, for dates printed without a year: the statement period, else its end alone (a
 * closing date), else the upload day. Null when none is known.
 */
export function statementDates(
  opts: Pick<AnalyzeOptions, 'statement' | 'referenceDate'>,
): StatementDates | null {
  const start = opts.statement?.periodStart ?? null;
  const end = opts.statement?.periodEnd ?? opts.referenceDate ?? null;
  if (!end) return null;
  return start && start <= end ? { start, end } : { end };
}

export interface Analysis {
  sheet: Sheet;
  fingerprint: string;
  proposal: MappingProposal & {
    profileId?: string;
    templateId?: string;
    accounts?: string[];
    accountColumn?: number | null;
  };
  parsed: ParseResult;
  balance: BalanceCheck;
  /** What dates printed without a year were read against (`statementDates`). */
  dates: StatementDates | null;
}

/** Picks the sheet with the most date-like rows (multi-sheet workbooks put the transactions on one sheet). */
export function pickSheet(sheets: readonly Sheet[]): Sheet {
  if (sheets.length === 1) return sheets[0]!;
  const score = (s: Sheet) =>
    s.rows.filter((r) => r.some((c) => /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(c))).length;
  return [...sheets].sort((a, b) => score(b) - score(a))[0]!;
}

/** A sheet's header and its fingerprint, as the import profile is keyed (IMP-04). */
function shape(sheet: Sheet, fileType: FileType) {
  const { headerRow, dataStart } = findHeaderRow(sheet.rows);
  const header = headerRow === null ? null : sheet.rows[headerRow]!;
  const width = Math.max(0, ...sheet.rows.slice(0, 50).map((r) => r.length));
  const fp = fingerprint(
    fileType,
    header,
    header?.length ?? width,
    headerRow === null ? sheet.rows[dataStart] : undefined,
  );
  return { header, fingerprint: fp };
}

/** The fingerprint `analyze` gives a file, without parsing it: what finds a saved profile before the account is known. */
export function sheetFingerprint(sheets: readonly Sheet[], fileType: FileType): string | null {
  if (sheets.length === 0) return null;
  return shape(pickSheet(sheets), fileType).fingerprint;
}

export function analyze(sheets: readonly Sheet[], opts: AnalyzeOptions, override?: ColumnMapping): Analysis {
  const sheet = override?.sheet
    ? (sheets.find((s) => s.name === override.sheet) ?? pickSheet(sheets))
    : pickSheet(sheets);
  const { header, fingerprint: fp } = shape(sheet, opts.fileType);

  const within = statementDates(opts);
  let proposal: Analysis['proposal'];
  if (override) {
    // A QIF/OFX grid keeps its columns whatever the user maps: the bank's ids still dedupe, and Quicken's Opening
    // Balance record is still the opening balance.
    const mapping = isFixedLayout(opts.fileType)
      ? { ...fixedDefaults(opts.fileType), ...override }
      : override;
    proposal = { mapping, confidence: 1, source: 'user', warnings: [], header };
  } else if (isFixedLayout(opts.fileType)) {
    // Every QIF (or OFX) grid has the same columns, so a saved profile can't tell one bank's file from another's: the
    // fixed mapping always applies, and a profile only settles the day/month order the user confirmed before.
    proposal = fixedProposal(sheet, opts.fileType, opts);
    const saved = opts.profiles?.find((p) => p.fingerprint === fp);
    const dates = sheet.rows
      .slice(1)
      .map((r) => r[FIXED.date] ?? '')
      .filter(Boolean);
    if (
      saved &&
      proposal.warnings.includes('ambiguous_date_format') &&
      dates.every((d) => parseDate(d, saved.mapping.dateFormat))
    ) {
      const warnings = proposal.warnings.filter((w) => w !== 'ambiguous_date_format');
      proposal = {
        ...proposal,
        mapping: { ...proposal.mapping, dateFormat: saved.mapping.dateFormat },
        warnings,
        confidence: warnings.includes('multiple_accounts_choose_one') ? proposal.confidence : 0.98,
        profileId: saved.id,
      };
    }
  } else {
    const saved = opts.profiles?.find((p) => p.fingerprint === fp);
    const template = saved ? null : matchTemplate(sheet, opts.accountFilter);
    proposal = saved
      ? fromProfile(sheet, saved, header, opts.accountFilter)
      : template
        ? template
        : inferMapping(sheet, {
            ...opts,
            dates: within,
            period:
              opts.statement?.periodStart && opts.statement.periodEnd
                ? { start: opts.statement.periodStart, end: opts.statement.periodEnd }
                : null,
          });
  }
  // A multi-account file the templates don't know: keep the asked account's rows, by its account column.
  if (opts.accountFilter && !proposal.mapping.filter && header && !isFixedLayout(opts.fileType)) {
    const column = findAccountColumn(header);
    if (column !== null)
      proposal = {
        ...proposal,
        mapping: { ...proposal.mapping, filter: { column, values: [opts.accountFilter] } },
        accountColumn: column,
      };
  }
  const parsed: ParseResult =
    proposal.confidence > 0
      ? applyMapping(sheet, proposal.mapping, opts.currency, within)
      : {
          rows: [],
          errors: [],
          skipped: [],
          read: 0,
          minDate: null,
          maxDate: null,
          opening: null,
          closing: null,
        };
  // OFX states each account's closing balance (LEDGERBAL); it's the statement's when the import is of that account.
  if (parsed.closing === null && sheet.accounts?.length) {
    const filtered = proposal.mapping.filter?.values ?? [];
    const account =
      sheet.accounts.length === 1
        ? sheet.accounts[0]!
        : filtered.length === 1
          ? sheet.accounts.find((x) => x.name === filtered[0])
          : undefined;
    if (account?.closing)
      parsed.closing = parseAmount(account.closing, opts.currency, proposal.mapping.decimal);
  }
  const opening = opts.statement?.opening ?? parsed.opening;
  const closing = opts.statement?.closing ?? parsed.closing;
  return {
    sheet,
    fingerprint: fp,
    proposal,
    parsed,
    balance: checkBalance(parsed.rows, opening, closing),
    dates: within,
  };
}
