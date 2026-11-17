/**
 * Finding a statement's account or a bill's biller, and learning it (ADR-0051). Pure: the API looks the signals up in
 * the workspace's accounts, billers, profiles and match memory.
 */
import { createHash } from 'node:crypto';
import { normalizeDescription } from './payees.js';

/** Confirmations of one signal to one target, with no correction in between, after which the match is automatic. */
export const LEARN_AFTER = 3;

/** One signal's memory: the target it points to and the confirmations in a row. */
export interface MatchMemoryState {
  targetId: string;
  confirmations: number;
}

/**
 * A person picked `targetId` for a document with this signal. The same target as the memory's is one more
 * confirmation; any other is a correction, and counting starts again at 1 for the new target.
 */
export function learnMatch(
  prev: MatchMemoryState | null,
  targetId: string,
): MatchMemoryState & { corrected: boolean } {
  if (!prev) return { targetId, confirmations: 1, corrected: false };
  if (prev.targetId === targetId)
    return { targetId, confirmations: prev.confirmations + 1, corrected: false };
  return { targetId, confirmations: 1, corrected: true };
}

/** Whether the memory picks its target on its own. */
export const isLearned = (m: MatchMemoryState | null | undefined): boolean =>
  !!m && m.confirmations >= LEARN_AFTER;

/** An automatic match was undone: it may have been the wrong target, so it has to be confirmed three times again. */
export const forgetMatch = (m: MatchMemoryState): MatchMemoryState => ({ ...m, confirmations: 0 });

// ---------------------------------------------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------------------------------------------

const stripExtension = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '');

/**
 * Last four digits in a file name (`Chase1234_Activity_20261101.csv` → `1234`): only when exactly one run of four
 * digits isn't a year (19xx, 20xx). Longer runs (dates) don't count.
 */
export function fileNameLast4(fileName: string): string | null {
  const runs = [...stripExtension(fileName).matchAll(/(?<!\d)\d{4}(?!\d)/g)].map((m) => m[0]);
  const digits = runs.filter((r) => !/^(19|20)\d\d$/.test(r));
  return digits.length === 1 ? digits[0]! : null;
}

/** A file name's shape: lower-cased, every run of digits as `#`, separators as `_` (`chase#_activity_#`). */
export function fileNamePattern(fileName: string): string | null {
  const p = stripExtension(fileName.trim())
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[\s_\-.()[\]]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // A name that is only digits and separators says nothing.
  return /[a-z]/.test(p) ? p.slice(0, 120) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------------------------------------------

/** An institution's name compared as words: "JPMorgan Chase Bank, N.A." → "jpmorgan chase bank n a". */
export const institutionKey = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Account numbers are kept only as a hash. */
const hashed = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export interface StatementClues {
  fileType: 'csv' | 'xlsx' | 'xls' | 'pdf' | 'qif' | 'ofx' | 'image';
  /** Printed on the statement ("account ending 1234"). */
  printedLast4?: string | null;
  /** The institution the statement names. */
  issuer?: string | null;
  /** The first OFX statement's account. */
  ofx?: { bankId: string | null; acctId: string; org: string | null } | null;
  fileName: string;
  /** The grid's header fingerprint (CSV, XLSX, XLS, QIF). */
  fingerprint?: string | null;
}

/**
 * The most specific signal a statement gives (ADR-0051 §2), the key of its match memory, or null when it gives none
 * (it's then matched by hand every time).
 */
export function statementSignal(c: StatementClues): string | null {
  if (c.fileType === 'ofx') {
    if (!c.ofx) return null;
    const bank = c.ofx.bankId || (c.ofx.org ? institutionKey(c.ofx.org) : '');
    return `ofx:${bank}:${hashed(c.ofx.acctId)}`;
  }
  if (c.fileType === 'pdf' || c.fileType === 'image') {
    if (c.printedLast4 && /^\d{4}$/.test(c.printedLast4)) return `last4:${c.printedLast4}`;
    if (c.issuer) return `issuer:${institutionKey(c.issuer)}`;
    return null;
  }
  // Spreadsheets, CSV and QIF: digits in the file name, else the header together with the file-name pattern.
  const last4 = fileNameLast4(c.fileName);
  if (last4) return `last4:${last4}`;
  const pattern = fileNamePattern(c.fileName);
  if (!c.fingerprint || !pattern) return null;
  return `shape:${c.fingerprint}:${pattern}`;
}

/** A bill's signal: the account number's last four digits, else the provider's name as payees are compared. */
export function billSignal(c: { accountLast4?: string | null; billerName?: string | null }): string | null {
  if (c.accountLast4 && /^\d{4}$/.test(c.accountLast4)) return `last4:${c.accountLast4}`;
  const name = c.billerName?.trim();
  if (!name) return null;
  return `name:${normalizeDescription(name) || name.toUpperCase()}`;
}

/**
 * A tax form's issuer signal (ADR-0052 §4), the most specific the form gives: a W-2 by its employer's EIN, else its
 * name as payees are compared; a 1099 or 1098 by the issuer's EIN with the account's last four digits, else the EIN,
 * else the name. Only a signal with an EIN is matched after one confirmation; a name-only one needs `LEARN_AFTER`.
 */
export function taxIssuerSignal(c: {
  kind: string;
  ein?: string | null;
  accountLast4?: string | null;
  issuerName?: string | null;
}): string | null {
  const name = c.issuerName?.trim();
  const key = name ? normalizeDescription(name) || name.toUpperCase() : null;
  const ein = c.ein && /^\d{9}$/.test(c.ein) ? c.ein : null;
  const last4 = c.accountLast4 && /^\d{4}$/.test(c.accountLast4) ? c.accountLast4 : null;
  if (c.kind === 'w2') return ein ? `w2:ein:${ein}` : key ? `w2:name:${key}` : null;
  if (ein) return last4 ? `${c.kind}:ein:${ein}:last4:${last4}` : `${c.kind}:ein:${ein}`;
  return key ? `${c.kind}:name:${key}` : null;
}

/** Whether a tax issuer signal names an EIN, so one confirmation (last year's) is enough to match it (§4). */
export const taxSignalHasEin = (signal: string): boolean => /:ein:\d{9}/.test(signal);

// ---------------------------------------------------------------------------------------------------------------
// Clean imports
// ---------------------------------------------------------------------------------------------------------------

export interface ImportOutcome {
  status: string;
  balanceCheck: 'ok' | 'mismatch' | 'n_a' | string | null;
  counts: { new: number; match: number; duplicate: number; probableDuplicate: number; error: number };
}

export type UncleanReason =
  'needs_mapping' | 'duplicates' | 'errors' | 'balance' | 'nothing_new' | 'import_failed';

/**
 * Whether an import can be committed with nobody looking (ADR-0051 §4), using the import's own checks: it went
 * straight to preview, with no likely duplicates, no rows in error, a balance check that didn't fail, and something new.
 */
export function cleanImport(o: ImportOutcome): { clean: true } | { clean: false; reason: UncleanReason } {
  if (o.status === 'needs_mapping') return { clean: false, reason: 'needs_mapping' };
  if (o.status !== 'preview') return { clean: false, reason: 'import_failed' };
  if (o.counts.probableDuplicate > 0) return { clean: false, reason: 'duplicates' };
  if (o.counts.error > 0) return { clean: false, reason: 'errors' };
  if (o.balanceCheck === 'mismatch') return { clean: false, reason: 'balance' };
  if (o.counts.new + o.counts.match === 0) return { clean: false, reason: 'nothing_new' };
  return { clean: true };
}
