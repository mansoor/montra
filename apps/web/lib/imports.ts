/**
 * Client side of statement import (IMP-03..08): the mapping editor's model, a live preview of the first rows
 * and the display rules for preview rows, warnings and failures. The preview mirrors @montra/importers'
 * date, amount and row rules (that package also reads spreadsheets, so it stays out of the browser bundle);
 * the API re-parses the whole file with the real importer once the mapping is saved.
 */
import {
  asCurrencyCode,
  fromParts,
  isCalendarDate,
  isCurrencyCode,
  minorUnits,
  parseDecimal,
  rescale,
} from '@montra/domain';
import type { ColumnMapping, ImportBatchDto, ImportRowDto } from '@montra/api-client';

// ----- Mapping editor ---------------------------------------------------------------------------------------

export const COLUMN_ROLES = [
  'ignore',
  'date',
  'description',
  'payee',
  'amount',
  'debit',
  'credit',
  'balance',
  'category',
  'reference',
] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

/** Roles that one column at most can have (description takes up to four, joined in column order). */
const SINGLE: ColumnRole[] = [
  'date',
  'payee',
  'amount',
  'debit',
  'credit',
  'balance',
  'category',
  'reference',
];
const MAX_DESCRIPTION = 4;

export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYYMMDD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'MM/DD/YY',
  'DD/MM/YY',
  'DD.MM.YY',
  'D MMM YYYY',
  'MMM D YYYY',
  'DD-MMM-YY',
  'DD-MMM-YYYY',
] as const satisfies readonly ColumnMapping['dateFormat'][];
export type DateFormatId = ColumnMapping['dateFormat'];

/** What the mapping form edits: one role per column plus the parsing options. */
export interface MappingDraft {
  roles: ColumnRole[];
  headerRow: number | null;
  dataStart: number;
  dateFormat: DateFormatId;
  decimal: '.' | ',';
  sign: 'normal' | 'inverted';
  /** Options the form does not edit (sheet, direction column, footer patterns, account filter). */
  rest: Pick<ColumnMapping, 'sheet' | 'direction' | 'skipPatterns' | 'filter'>;
}

/** The role each of `columns` columns has under a mapping. */
export function columnRoles(m: ColumnMapping | null, columns: number): ColumnRole[] {
  const roles: ColumnRole[] = Array.from({ length: columns }, () => 'ignore');
  if (!m) return roles;
  const set = (col: number | undefined, role: ColumnRole) => {
    if (col !== undefined && col < columns) roles[col] = role;
  };
  for (const c of m.description) set(c, 'description');
  set(m.payee, 'payee');
  set(m.category, 'category');
  set(m.reference, 'reference');
  set(m.balance, 'balance');
  set(m.debit, 'debit');
  set(m.credit, 'credit');
  set(m.amount, 'amount');
  set(m.date, 'date');
  return roles;
}

export function draftFromMapping(m: ColumnMapping | null, columns: number): MappingDraft {
  return {
    roles: columnRoles(m, columns),
    headerRow: m ? m.headerRow : 0,
    dataStart: m ? m.dataStart : 1,
    dateFormat: m?.dateFormat ?? 'YYYY-MM-DD',
    decimal: m?.decimal ?? '.',
    sign: m?.sign ?? 'normal',
    rest: {
      ...(m?.sheet !== undefined ? { sheet: m.sheet } : {}),
      ...(m?.direction ? { direction: m.direction } : {}),
      ...(m?.skipPatterns ? { skipPatterns: m.skipPatterns } : {}),
      ...(m?.filter ? { filter: m.filter } : {}),
    },
  };
}

/**
 * Gives column `col` a role. Single roles move (the previous column becomes "ignore"); an amount column and
 * debit/credit columns are alternatives, so choosing one clears the other.
 */
export function applyRole(draft: MappingDraft, col: number, role: ColumnRole): MappingDraft {
  const clears = new Set<ColumnRole>(SINGLE.includes(role) ? [role] : []);
  if (role === 'amount') ['debit', 'credit'].forEach((r) => clears.add(r as ColumnRole));
  if (role === 'debit' || role === 'credit') clears.add('amount');
  const roles = draft.roles.map((r, i) => (i !== col && clears.has(r) ? 'ignore' : r));
  roles[col] = role;
  // The direction column (e.g. "Type: DEBIT/CREDIT") is tied to the amount column; drop it if remapped.
  const rest = { ...draft.rest };
  if (rest.direction && rest.direction.column === col && role !== 'ignore') delete rest.direction;
  return { ...draft, roles, rest };
}

/** i18n keys for what still stops the draft from being a valid mapping (empty when it can be saved). */
export function mappingErrors(draft: MappingDraft): string[] {
  const count = (role: ColumnRole) => draft.roles.filter((r) => r === role).length;
  const errors: string[] = [];
  if (count('date') !== 1) errors.push('imports.mapping.need_date');
  if (count('amount') === 0 && (count('debit') === 0 || count('credit') === 0))
    errors.push('imports.mapping.need_amount');
  if (count('description') > MAX_DESCRIPTION) errors.push('imports.mapping.too_many_descriptions');
  if (draft.headerRow !== null && draft.dataStart <= draft.headerRow)
    errors.push('imports.mapping.data_before_header');
  return errors;
}

/** The ColumnMapping for a valid draft (check `mappingErrors` first). */
export function draftToMapping(draft: MappingDraft): ColumnMapping {
  const col = (role: ColumnRole) => {
    const i = draft.roles.indexOf(role);
    return i >= 0 ? i : undefined;
  };
  const optional = (role: ColumnRole) => {
    const i = col(role);
    return i === undefined ? {} : { [role]: i };
  };
  return {
    ...draft.rest,
    headerRow: draft.headerRow,
    dataStart: draft.dataStart,
    date: col('date') ?? 0,
    dateFormat: draft.dateFormat,
    description: draft.roles.flatMap((r, i) => (r === 'description' ? [i] : [])),
    ...optional('payee'),
    ...optional('amount'),
    ...optional('debit'),
    ...optional('credit'),
    ...optional('balance'),
    ...optional('category'),
    ...optional('reference'),
    sign: draft.sign,
    decimal: draft.decimal,
  };
}

// ----- Live preview (mirrors @montra/importers parse rules) ------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  mär: 3,
  mrz: 3,
  mai: 5,
  okt: 10,
  dez: 12,
  janv: 1,
  févr: 2,
  avr: 4,
  juil: 7,
  déc: 12,
  ene: 1,
  abr: 4,
  ago: 8,
  dic: 12,
};

type Part = 'y' | 'yy' | 'm' | 'd' | 'mon';

const PATTERNS: Record<DateFormatId, [RegExp, Part[]]> = {
  'YYYY-MM-DD': [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, ['y', 'm', 'd']],
  'YYYY/MM/DD': [/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, ['y', 'm', 'd']],
  YYYYMMDD: [/^(\d{4})(\d{2})(\d{2})$/, ['y', 'm', 'd']],
  'MM/DD/YYYY': [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, ['m', 'd', 'y']],
  'DD/MM/YYYY': [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, ['d', 'm', 'y']],
  'MM-DD-YYYY': [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, ['m', 'd', 'y']],
  'DD-MM-YYYY': [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, ['d', 'm', 'y']],
  'DD.MM.YYYY': [/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, ['d', 'm', 'y']],
  'MM/DD/YY': [/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, ['m', 'd', 'yy']],
  'DD/MM/YY': [/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, ['d', 'm', 'yy']],
  'DD.MM.YY': [/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/, ['d', 'm', 'yy']],
  'D MMM YYYY': [/^(\d{1,2})\.?\s+([a-zäéû]{3,5})\.?,?\s+(\d{4})$/i, ['d', 'mon', 'y']],
  'MMM D YYYY': [/^([a-zäéû]{3,5})\.?\s+(\d{1,2}),?\s+(\d{4})$/i, ['mon', 'd', 'y']],
  'DD-MMM-YY': [/^(\d{1,2})[- ]([a-zäéû]{3,5})[- ](\d{2})$/i, ['d', 'mon', 'yy']],
  'DD-MMM-YYYY': [/^(\d{1,2})[- ]([a-zäéû]{3,5})[- ](\d{4})$/i, ['d', 'mon', 'y']],
};

/** Parses a statement date cell (a trailing time is ignored); null when it doesn't match the format. */
export function parseStatementDate(input: string, format: DateFormatId): string | null {
  const text = input
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(AM|PM|Z|[+-]\d{2}:?\d{2})?$/i, '');
  const [re, order] = PATTERNS[format];
  const m = re.exec(text);
  if (!m) return null;
  let y = 0;
  let mo = 0;
  let d = 0;
  for (const [i, part] of order.entries()) {
    const v = m[i + 1]!;
    if (part === 'y') y = Number(v);
    else if (part === 'yy') y = Number(v) < 70 ? 2000 + Number(v) : 1900 + Number(v);
    else if (part === 'm') mo = Number(v);
    else if (part === 'd') d = Number(v);
    else mo = MONTHS[v.toLowerCase().replace('.', '')] ?? 0;
  }
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isCalendarDate(iso) && y >= 1990 && y <= 2100 ? fromParts(y, mo, d) : null;
}

const CURRENCY_NOISE = /(?:[A-Z]{3}|[$€£¥₹₩₪₫₺₴₦₱฿]|R\$|CHF|kr\.?|zł|Fr\.)/gi;

/** Parses a statement amount cell into signed minor units (symbols, groups, parentheses, CR/DR markers). */
export function parseStatementAmount(raw: string, currency: string, decimal: '.' | ','): bigint | null {
  let s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  let marker = 0;
  const crdr = /\s*\b(CR|DR|Cr|Dr|H|S)\.?$/.exec(s);
  if (crdr) {
    marker = /^(CR|Cr|H)$/.test(crdr[1]!) ? 1 : -1;
    s = s.slice(0, crdr.index);
  }
  s = s.replace(CURRENCY_NOISE, '').replace(/\s+/g, ' ').trim();
  if (!/\d/.test(s) || /[a-z]/i.test(s)) return null;
  const code = currency.toUpperCase();
  try {
    const d = parseDecimal(s, { decimal, group: decimal === '.' ? ", '" : ". '" });
    let minor = rescale(d, isCurrencyCode(code) ? minorUnits(asCurrencyCode(code)) : 2, 'half_up');
    if (marker === -1 && minor > 0n) minor = -minor;
    if (marker === 1 && minor < 0n) minor = -minor;
    return minor;
  } catch {
    return null;
  }
}

const FOOTER =
  /^(total|totals|summe|subtotal|opening balance|closing balance|beginning balance|ending balance|balance forward|previous balance|anfangssaldo|endsaldo|schlusssaldo)\b/i;

export interface PreviewRow {
  /** 1-based row number in the file. */
  rowNo: number;
  date: string | null;
  /** Signed minor units: + money in, − money out. */
  amount: bigint | null;
  description: string;
  error: 'invalid_date' | 'invalid_amount' | 'missing_amount' | null;
}

/**
 * The first `limit` data rows of `sample` under `m`, as the importer would read them: rows before `dataStart`,
 * blank rows, footers and rows of other accounts are skipped; bad dates and amounts are reported per row.
 */
export function previewMapping(
  sample: string[][],
  m: ColumnMapping,
  currency: string,
  limit = 5,
): PreviewRow[] {
  const out: PreviewRow[] = [];
  const filterValues = m.filter ? new Set(m.filter.values.map((v) => v.toLowerCase())) : null;
  const debitWords = m.direction ? new Set(m.direction.debitValues.map((v) => v.toLowerCase())) : null;
  const amountOf = (r: string[]): bigint | null => {
    if (m.amount !== undefined) return parseStatementAmount(r[m.amount] ?? '', currency, m.decimal);
    const d = m.debit !== undefined ? parseStatementAmount(r[m.debit] ?? '', currency, m.decimal) : null;
    const c = m.credit !== undefined ? parseStatementAmount(r[m.credit] ?? '', currency, m.decimal) : null;
    if (d === null && c === null) return null;
    const abs = (x: bigint) => (x < 0n ? -x : x);
    return (c !== null ? abs(c) : 0n) - (d !== null ? abs(d) : 0n);
  };
  for (let i = m.dataStart; i < sample.length && out.length < limit; i++) {
    const r = sample[i]!;
    if (r.every((c) => !c.trim())) continue;
    const first = (r.find((c) => c.trim()) ?? '').trim();
    const footer =
      FOOTER.test(first) || m.skipPatterns?.some((p) => first.toLowerCase().startsWith(p.toLowerCase()));
    const date = parseStatementDate(r[m.date] ?? '', m.dateFormat);
    if (footer && !date) continue;
    if (filterValues && m.filter && !filterValues.has((r[m.filter.column] ?? '').trim().toLowerCase()))
      continue;
    const description = m.description
      .map((c) => (r[c] ?? '').trim())
      .filter(Boolean)
      .join(' · ');
    const row: PreviewRow = { rowNo: i + 1, date, amount: null, description, error: null };
    if (!date) {
      out.push({ ...row, error: 'invalid_date' });
      continue;
    }
    let amount = amountOf(r);
    if (amount === null) {
      const text =
        m.amount !== undefined
          ? (r[m.amount] ?? '').trim()
          : `${r[m.debit ?? -1] ?? ''}${r[m.credit ?? -1] ?? ''}`.trim();
      out.push({ ...row, error: text ? 'invalid_amount' : 'missing_amount' });
      continue;
    }
    if (debitWords && m.direction) {
      const abs = amount < 0n ? -amount : amount;
      amount = debitWords.has((r[m.direction.column] ?? '').trim().toLowerCase()) ? -abs : abs;
    } else if (m.sign === 'inverted') {
      amount = -amount;
    }
    out.push({ ...row, amount });
  }
  return out;
}

// ----- Preview rows, warnings and failures -----------------------------------------------------------------

export type Tone = 'good' | 'bad' | 'warn' | 'muted';

const STATUS_TONE: Record<ImportRowDto['status'], Tone> = {
  new: 'good',
  duplicate: 'muted',
  probable_duplicate: 'warn',
  match: 'good',
  error: 'bad',
};

export interface RowDisplay {
  statusKey: string;
  statusTone: Tone;
  /** What commit will do: the visible outcome. */
  effectiveKey: string;
  /** The decision a Skip/Import toggle sends, or null when the row can't be imported (parse error). */
  toggle: { decision: 'import' | 'skip' | 'match'; labelKey: string } | null;
  /** Existing transaction this row matches or duplicates. */
  linkedTransactionId: string | null;
  errorKey: string | null;
}

export function rowDisplay(row: ImportRowDto): RowDisplay {
  let toggle: RowDisplay['toggle'] = null;
  if (row.effective === 'skip') {
    // A skipped match goes back to matching; anything else is imported as new.
    toggle =
      row.status === 'match'
        ? { decision: 'match', labelKey: 'imports.preview.match_again' }
        : { decision: 'import', labelKey: 'imports.preview.import' };
  } else if (row.effective !== 'fail') {
    toggle = { decision: 'skip', labelKey: 'imports.preview.skip' };
  }
  return {
    statusKey: `imports.row_status.${row.status}`,
    statusTone: STATUS_TONE[row.status],
    effectiveKey: `imports.effective.${row.effective}`,
    toggle,
    linkedTransactionId: row.matchTransactionId ?? row.duplicateOfTransactionId,
    errorKey: row.error ? (ROW_ERROR_KEYS[row.error] ?? null) : null,
  };
}

const ROW_ERROR_KEYS: Record<string, string> = {
  invalid_date: 'imports.row_error.invalid_date',
  invalid_amount: 'imports.row_error.invalid_amount',
  missing_amount: 'imports.row_error.missing_amount',
};

/** Warning codes the importer and API emit, with their catalog keys. */
export const WARNING_KEYS: Record<string, string> = {
  ambiguous_date_format: 'imports.warning.ambiguous_date_format',
  balance_column_does_not_reconcile: 'imports.warning.balance_column_does_not_reconcile',
  no_negative_amounts: 'imports.warning.no_negative_amounts',
  multiple_accounts_choose_one: 'imports.warning.multiple_accounts_choose_one',
  partial_undo: 'imports.warning.partial_undo',
  no_date_column: 'imports.warning.no_date_column',
  no_amount_column: 'imports.warning.no_amount_column',
  no_description_column: 'imports.warning.no_description_column',
};

export const warningKey = (code: string): string => WARNING_KEYS[code] ?? 'imports.warning.unknown';

/** Failure codes (`batch.error` is "code: detail") with a plain-language message. */
export const IMPORT_ERROR_KEYS: Record<string, string> = {
  'pdf.no_text_layer': 'imports.error.pdf_no_text_layer',
  'doc.corrupt': 'imports.error.doc_corrupt',
  'doc.too_large': 'imports.error.doc_too_large',
  'doc.type_mismatch': 'imports.error.doc_type_mismatch',
  'doc.unsupported_type': 'imports.error.unsupported_type',
  'upload.unsupported_type': 'imports.error.unsupported_type',
  'upload.too_large': 'imports.error.doc_too_large',
  'upload.empty': 'imports.error.empty',
  'import.no_grid': 'imports.error.no_grid',
  'import.commit_failed': 'imports.error.commit_failed',
};

/** The error code at the start of a job error ("pdf.no_text_layer: this PDF looks scanned"). */
export function errorCode(error: string | null): string | null {
  return error ? (/^([a-z_]+\.[a-z_]+)(?::|$)/.exec(error.trim())?.[1] ?? null) : null;
}

/** Catalog key for a failed batch's error, or null to show the raw detail. */
export function importErrorKey(error: string | null): string | null {
  const code = errorCode(error);
  return code ? (IMPORT_ERROR_KEYS[code] ?? null) : null;
}

// ----- Batch lifecycle --------------------------------------------------------------------------------------

export const BATCH_TONE: Record<ImportBatchDto['status'], Tone> = {
  uploaded: 'muted',
  parsing: 'muted',
  needs_mapping: 'warn',
  preview: 'warn',
  committing: 'muted',
  committed: 'good',
  failed: 'bad',
  undone: 'muted',
};

/** Statuses during which the worker is busy and the page polls. */
export const isBusy = (status: ImportBatchDto['status']) =>
  status === 'uploaded' || status === 'parsing' || status === 'committing';

export const canUndo = (batch: ImportBatchDto, now: Date = new Date()) =>
  batch.status === 'committed' && batch.undoUntil !== null && new Date(batch.undoUntil) > now;

/** Accepted upload types (IMP-01) and the size limit. */
export const ACCEPTED_EXTENSIONS = ['csv', 'tsv', 'txt', 'xls', 'xlsx', 'pdf'];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function fileProblem(file: { name: string; size: number }): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ACCEPTED_EXTENSIONS.includes(ext)) return 'imports.upload.bad_type';
  if (file.size === 0) return 'imports.error.empty';
  if (file.size > MAX_UPLOAD_BYTES) return 'imports.error.doc_too_large';
  return null;
}
