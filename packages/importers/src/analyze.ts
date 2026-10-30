/**
 * Entry point used by the import worker: choose a mapping (saved profile → app template → heuristics),
 * parse, and check balances (design 04 §3 steps 2–6).
 */
import type { CalendarDate, CurrencyCode } from '@montra/domain';
import type { FileType } from './decode.js';
import { fingerprint } from './fingerprint.js';
import type { Sheet } from './grid.js';
import { findHeaderRow, inferMapping } from './infer.js';
import type { ColumnMapping, MappingProposal } from './mapping.js';
import { applyMapping, checkBalance, type BalanceCheck, type ParseResult } from './parse.js';
import { matchTemplate } from './templates.js';

export interface SavedProfile {
  id: string;
  fingerprint: string;
  mapping: ColumnMapping;
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
}

export interface Analysis {
  sheet: Sheet;
  fingerprint: string;
  proposal: MappingProposal & { profileId?: string; templateId?: string; accounts?: string[] };
  parsed: ParseResult;
  balance: BalanceCheck;
}

/** Picks the sheet with the most date-like rows (multi-sheet workbooks put the transactions on one sheet). */
export function pickSheet(sheets: readonly Sheet[]): Sheet {
  if (sheets.length === 1) return sheets[0]!;
  const score = (s: Sheet) =>
    s.rows.filter((r) => r.some((c) => /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(c))).length;
  return [...sheets].sort((a, b) => score(b) - score(a))[0]!;
}

export function analyze(sheets: readonly Sheet[], opts: AnalyzeOptions, override?: ColumnMapping): Analysis {
  const sheet = override?.sheet
    ? (sheets.find((s) => s.name === override.sheet) ?? pickSheet(sheets))
    : pickSheet(sheets);
  const { headerRow, dataStart } = findHeaderRow(sheet.rows);
  const header = headerRow === null ? null : sheet.rows[headerRow]!;
  const width = Math.max(0, ...sheet.rows.slice(0, 50).map((r) => r.length));
  const fp = fingerprint(
    opts.fileType,
    header,
    header?.length ?? width,
    headerRow === null ? sheet.rows[dataStart] : undefined,
  );

  let proposal: Analysis['proposal'];
  if (override) {
    proposal = { mapping: override, confidence: 1, source: 'user', warnings: [], header };
  } else {
    const saved = opts.profiles?.find((p) => p.fingerprint === fp);
    const template = saved ? null : matchTemplate(sheet, opts.accountFilter);
    proposal = saved
      ? {
          mapping: saved.mapping,
          confidence: 1,
          source: 'profile',
          warnings: [],
          header,
          profileId: saved.id,
        }
      : template
        ? template
        : inferMapping(sheet, {
            ...opts,
            period:
              opts.statement?.periodStart && opts.statement.periodEnd
                ? { start: opts.statement.periodStart, end: opts.statement.periodEnd }
                : null,
          });
  }
  const parsed =
    proposal.confidence > 0
      ? applyMapping(sheet, proposal.mapping, opts.currency)
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
  const opening = opts.statement?.opening ?? parsed.opening;
  const closing = opts.statement?.closing ?? parsed.closing;
  return { sheet, fingerprint: fp, proposal, parsed, balance: checkBalance(parsed.rows, opening, closing) };
}
