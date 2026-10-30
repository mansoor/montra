/**
 * Heuristic column inference (design 04 §3.3): header-row detection, per-column value profiles, header
 * keyword hints, debit/credit pair detection, running-balance verification and sign inference.
 */
import type { CurrencyCode } from '@montra/domain';
import { amountRate, detectDecimalSeparator, parseAmount, type DecimalSeparator } from './amounts.js';
import { detectDateFormat, parseDate, type DateFormatId } from './dates.js';
import type { ColumnMapping, MappingProposal } from './mapping.js';
import type { Sheet } from './grid.js';

type Role =
  | 'date'
  | 'description'
  | 'payee'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'balance'
  | 'category'
  | 'reference'
  | 'direction';

const KEYWORDS: Record<Role, RegExp> = {
  date: /^(trans(action)?\.?\s*date|date|posted|posting date|post date|booking date|buchungstag|datum|fecha|data|started date|completed date|value date|valuta(datum)?)$/i,
  description:
    /(description|details|narrative|memo|verwendungszweck|buchungstext|beschreibung|transaction|reference text|particulars|original statement|name|libell[ée]|concepto)/i,
  payee: /^(payee|merchant|beg(ü|ue)nstigter.*|counterparty|recipient|zahlungspflichtiger.*)$/i,
  amount: /^(amount|betrag|value|importe|montant|transaction amount|amount \(.*\)|amt)$/i,
  debit: /^(debit|debits|withdrawals?|money out|paid out|outflow|soll|ausgang|charges?)( amount)?$/i,
  credit: /^(credit|credits|deposits?|money in|paid in|inflow|haben|eingang|payments?)( amount)?$/i,
  balance: /(balance|saldo|running bal|kontostand)/i,
  category: /^(category|sub-?category|kategorie)$/i,
  reference: /(reference|ref\.?|check( or slip)? ?#|cheque|number|transaction id)/i,
  direction: /^(type|transaction type|dr\/cr|debit\/credit|cr\/dr|soll\/haben)$/i,
};

const FOOTER =
  /^(total|totals|summe|subtotal|opening balance|closing balance|beginning balance|ending balance|balance forward|previous balance)\b/i;

interface Profile {
  index: number;
  header: string;
  values: string[];
  nonEmpty: number;
  date: { format: DateFormatId; rate: number; ambiguous: boolean } | null;
  amount: number; // parse rate
  decimals: number; // share of amounts with a fractional part
  negatives: number; // share of amounts that are negative
  avgLength: number;
  distinct: number;
  letters: number; // share of values containing letters
}

export interface InferOptions {
  currency: CurrencyCode;
  /** Account type of the import target; card exports often list purchases as positive. */
  accountType: 'asset' | 'liability';
  /** Day-first default when dates are ambiguous (e.g. en-GB, de-DE). */
  preferDayFirst?: boolean;
}

const nonEmptyCells = (row: string[]) => row.filter((c) => c.trim()).length;
const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** Finds the header row: a mostly-text row followed by rows that contain a date and a number. */
export function findHeaderRow(rows: string[][]): { headerRow: number | null; dataStart: number } {
  const limit = Math.min(rows.length, 40);
  const isDataRow = (r: string[] | undefined) => {
    if (!r || nonEmptyCells(r) < 2) return false;
    const hasDate = r.some((c) => detectDateFormat([c]) !== null);
    const hasNumber = r.some(
      (c) =>
        /\d/.test(c) &&
        detectDateFormat([c]) === null &&
        (parseAmount(c, 'USD', '.') !== null || parseAmount(c, 'USD', ',') !== null),
    );
    return hasDate && hasNumber;
  };
  for (let i = 0; i < limit; i++) {
    const r = rows[i]!;
    if (nonEmptyCells(r) < 2) continue;
    const texty =
      r.filter((c) => c.trim() && /[a-z]/i.test(c) && detectDateFormat([c]) === null).length /
      nonEmptyCells(r);
    const next = rows.slice(i + 1, i + 6).filter((x) => nonEmptyCells(x) >= 2);
    const following = next.filter(isDataRow).length;
    if (texty >= 0.6 && following >= Math.min(2, next.length) && following > 0)
      return { headerRow: i, dataStart: i + 1 };
    if (isDataRow(r)) return { headerRow: null, dataStart: i };
  }
  return { headerRow: null, dataStart: 0 };
}

function profileColumns(
  rows: string[][],
  header: string[] | null,
  width: number,
  preferDayFirst: boolean,
): Profile[] {
  const profiles: Profile[] = [];
  for (let c = 0; c < width; c++) {
    const values = rows.map((r) => (r[c] ?? '').trim());
    const filled = values.filter(Boolean);
    const decimal = detectDecimalSeparator(filled);
    const amounts = filled.map((v) => parseAmount(v, 'USD', decimal));
    const parsed = amounts.filter((a): a is bigint => a !== null);
    profiles.push({
      index: c,
      header: header?.[c]?.trim() ?? '',
      values,
      nonEmpty: filled.length,
      date: detectDateFormat(filled, preferDayFirst),
      amount: amountRate(filled, decimal),
      decimals: filled.length ? filled.filter((v) => /[.,]\d{1,3}\b/.test(v)).length / filled.length : 0,
      negatives: parsed.length ? parsed.filter((a) => a < 0n).length / parsed.length : 0,
      avgLength: filled.length ? filled.reduce((a, v) => a + v.length, 0) / filled.length : 0,
      distinct: filled.length ? new Set(filled).size / filled.length : 0,
      letters: filled.length ? filled.filter((v) => /[a-zäöüß]{2}/i.test(v)).length / filled.length : 0,
    });
  }
  return profiles;
}

/** Infers a mapping from a sheet. Confidence reflects how unambiguous each role assignment was. */
export function inferMapping(sheet: Sheet, opts: InferOptions): MappingProposal {
  const warnings: string[] = [];
  const { headerRow, dataStart } = findHeaderRow(sheet.rows);
  const header = headerRow === null ? null : sheet.rows[headerRow]!;
  const data = sheet.rows
    .slice(dataStart)
    .filter((r) => nonEmptyCells(r) >= 2 && !FOOTER.test((r.find((c) => c.trim()) ?? '').trim()));
  const width = Math.max(header?.length ?? 0, ...data.slice(0, 200).map((r) => r.length));
  const cols = profileColumns(data.slice(0, 500), header, width, opts.preferDayFirst ?? false);
  const hint = (p: Profile, role: Role) => (p.header && KEYWORDS[role].test(stripAccents(p.header)) ? 1 : 0);
  let confidence = 1;

  // --- date: highest parse rate; prefer "transaction" over "posted" dates when both exist.
  const dateCols = cols.filter((p) => p.date && p.date.rate >= 0.8);
  if (dateCols.length === 0) {
    return fail(header, dataStart, headerRow, 'no_date_column');
  }
  const date = [...dateCols].sort(
    (a, b) =>
      Number(/trans|buchung|started|date$/i.test(b.header)) -
        Number(/trans|buchung|started|date$/i.test(a.header)) ||
      Number(!/post|valuta|completed/i.test(b.header)) - Number(!/post|valuta|completed/i.test(a.header)) ||
      a.index - b.index,
  )[0]!;
  if (date.date!.ambiguous) {
    warnings.push('ambiguous_date_format');
    confidence -= 0.2;
  }

  // --- numeric candidates (exclude date columns and id-like integers without decimals).
  const numeric = cols.filter(
    (p) =>
      p.index !== date.index && !dateCols.includes(p) && p.nonEmpty > 0 && p.amount >= 0.6 && p.letters < 0.5,
  );
  const moneyish = numeric.filter(
    (p) =>
      p.decimals >= 0.5 || hint(p, 'amount') || hint(p, 'debit') || hint(p, 'credit') || hint(p, 'balance'),
  );

  // Debit/credit pair: two sparse columns that are mostly mutually exclusive.
  let debit: Profile | undefined;
  let credit: Profile | undefined;
  const byHint = (role: Role) => moneyish.find((p) => hint(p, role));
  debit = byHint('debit');
  credit = byHint('credit');
  if (debit && credit && debit !== credit) {
    const overlap = data.filter(
      (r) => (r[debit!.index] ?? '').trim() && (r[credit!.index] ?? '').trim(),
    ).length;
    if (overlap > data.length * 0.1) {
      debit = credit = undefined; // not a real pair
    }
  } else {
    debit = credit = undefined;
  }

  let balance = byHint('balance');
  let amount: Profile | undefined;
  if (!debit) {
    amount =
      byHint('amount') ??
      moneyish
        .filter((p) => p !== balance)
        .sort((a, b) => b.nonEmpty - a.nonEmpty || b.negatives - a.negatives)[0];
    if (!amount) return fail(header, dataStart, headerRow, 'no_amount_column');
    if (!byHint('amount')) confidence -= 0.15;
  }

  // Unlabelled balance column: verify it as a running balance against the amounts.
  const decimal = detectDecimalSeparator((amount ?? debit)!.values.filter(Boolean));
  const signedOf = (r: string[]) =>
    signedAmount(
      r,
      { amount: amount?.index, debit: debit?.index, credit: credit?.index },
      decimal,
      opts.currency,
    );
  if (!balance) {
    balance = moneyish
      .filter((p) => p !== amount && p !== debit && p !== credit)
      .find((p) => runningBalanceFit(data, p.index, signedOf, decimal, opts.currency) >= 0.9);
  }

  // Direction column (unsigned amounts plus a debit/credit word), e.g. Mint "Transaction Type".
  let direction: ColumnMapping['direction'];
  if (amount && amount.negatives === 0) {
    const dir = cols.find(
      (p) => hint(p, 'direction') && p.values.some((v) => /^(debit|dr|soll|s|withdrawal)$/i.test(v)),
    );
    if (dir)
      direction = {
        column: dir.index,
        debitValues: [...new Set(dir.values.filter((v) => /^(debit|dr|soll|s|withdrawal)$/i.test(v)))],
      };
  }

  // Description: the longest high-cardinality text columns, preferring keyword matches.
  const texts = cols.filter(
    (p) =>
      p.letters >= 0.5 && p.index !== date.index && !dateCols.includes(p) && p.index !== direction?.column,
  );
  const descriptionCols = texts
    .filter((p) => hint(p, 'description') || hint(p, 'payee'))
    .sort(
      (a, b) => Number(hint(b, 'description')) - Number(hint(a, 'description')) || b.avgLength - a.avgLength,
    );
  const description = (
    descriptionCols.length
      ? descriptionCols
      : [...texts].sort((a, b) => b.avgLength * b.distinct - a.avgLength * a.distinct)
  ).slice(0, 2);
  if (description.length === 0) {
    warnings.push('no_description_column');
    confidence -= 0.3;
  }
  if (!descriptionCols.length) confidence -= 0.1;
  const payee = texts.find((p) => hint(p, 'payee') && !description.slice(0, 1).includes(p));
  const category = cols.find((p) => hint(p, 'category'));
  const reference = cols.find((p) => hint(p, 'reference') && p !== amount && p !== balance);

  // Sign convention: the balance column decides when present; otherwise the account type and value mix do.
  let sign: ColumnMapping['sign'] = 'normal';
  if (balance) {
    const normal = runningBalanceFit(data, balance.index, signedOf, decimal, opts.currency);
    const inverted = runningBalanceFit(
      data,
      balance.index,
      (r) => negate(signedOf(r)),
      decimal,
      opts.currency,
    );
    sign = inverted > normal ? 'inverted' : 'normal';
    if (Math.max(normal, inverted) < 0.9) {
      warnings.push('balance_column_does_not_reconcile');
      confidence -= 0.1;
    }
  } else if (amount && !direction) {
    const neg = amount.negatives;
    if (opts.accountType === 'liability' && neg < 0.5) sign = 'inverted'; // purchases listed as positive
    if (opts.accountType === 'asset' && neg === 0) {
      warnings.push('no_negative_amounts');
      confidence -= 0.15;
    }
  }
  if (headerRow === null) confidence -= 0.15;

  const mapping: ColumnMapping = {
    headerRow,
    dataStart,
    date: date.index,
    dateFormat: date.date!.format,
    description: description.map((p) => p.index),
    ...(payee ? { payee: payee.index } : {}),
    ...(amount ? { amount: amount.index } : {}),
    ...(debit && credit ? { debit: debit.index, credit: credit.index } : {}),
    ...(direction ? { direction } : {}),
    sign,
    ...(balance ? { balance: balance.index } : {}),
    ...(category ? { category: category.index } : {}),
    ...(reference ? { reference: reference.index } : {}),
    decimal,
    ...(sheetName(sheet) ? { sheet: sheet.name } : {}),
  };
  return { mapping, confidence: Math.max(0, Math.min(1, confidence)), source: 'heuristic', warnings, header };
}

const sheetName = (s: Sheet) => (s.name && s.name !== 'CSV' ? s.name : undefined);
const negate = (n: bigint | null) => (n === null ? null : -n);

/** Signed amount of a row, before applying the sign convention. */
export function signedAmount(
  r: string[],
  m: { amount?: number; debit?: number; credit?: number },
  decimal: DecimalSeparator,
  currency: CurrencyCode,
): bigint | null {
  if (m.amount !== undefined) return parseAmount(r[m.amount] ?? '', currency, decimal);
  const d = m.debit !== undefined ? parseAmount(r[m.debit] ?? '', currency, decimal) : null;
  const c = m.credit !== undefined ? parseAmount(r[m.credit] ?? '', currency, decimal) : null;
  if (d === null && c === null) return null;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  return (c !== null ? abs(c) : 0n) - (d !== null ? abs(d) : 0n);
}

/** Share of consecutive rows where balance[i] − balance[i−1] equals the amount, in either row order. */
export function runningBalanceFit(
  rows: string[][],
  balanceCol: number,
  amountOf: (r: string[]) => bigint | null,
  decimal: DecimalSeparator,
  currency: CurrencyCode,
): number {
  const pairs = rows
    .map((r) => ({ bal: parseAmount(r[balanceCol] ?? '', currency, decimal), amt: amountOf(r) }))
    .filter((x): x is { bal: bigint; amt: bigint } => x.bal !== null && x.amt !== null);
  if (pairs.length < 3) return 0;
  let forward = 0;
  let backward = 0;
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i]!.bal - pairs[i - 1]!.bal === pairs[i]!.amt) forward++;
    if (pairs[i - 1]!.bal - pairs[i]!.bal === pairs[i - 1]!.amt) backward++; // newest first
  }
  return Math.max(forward, backward) / (pairs.length - 1);
}

function fail(
  header: string[] | null,
  dataStart: number,
  headerRow: number | null,
  warning: string,
): MappingProposal {
  return {
    mapping: {
      headerRow,
      dataStart,
      date: 0,
      dateFormat: 'YYYY-MM-DD',
      description: [],
      sign: 'normal',
      decimal: '.',
    },
    confidence: 0,
    source: 'heuristic',
    warnings: [warning],
    header,
  };
}

export { parseDate };
