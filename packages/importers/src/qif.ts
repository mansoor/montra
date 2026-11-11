/**
 * QIF (Quicken Interchange Format) reader (IMP-13, ADR-0030). A QIF file is a list of records, one field per line: the
 * first character names the field and `^` ends the record. `!Type:` lines start a section and `!Account` blocks name
 * the account the following sections belong to.
 *
 * - Bank, CCard, Cash, Oth A and Oth L sections are transactions.
 * - `!Type:Invst` (investment actions) is skipped with a counted warning; category, class and memorized lists are skipped.
 * - A split keeps its total as one row: its category is the splits' common category, or none when they differ.
 * - `L[Savings]` is a transfer: no category, and "Transfer : Savings" in its text, so the switch flow pairs it.
 */
import type { AccountKind } from '@montra/domain';
import { FIXED, FIXED_COLUMNS, fixedSheet } from './fixed-layout.js';
import type { Sheet, SheetAccount } from './grid.js';

const TRANSACTION_TYPES: Record<string, AccountKind | null> = {
  bank: null,
  ccard: 'credit_card',
  cash: 'cash',
  'oth a': 'asset',
  'oth l': 'liability',
};

interface QifRecord {
  [field: string]: string[];
}

const withoutBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** True when the text looks like a QIF file (its first non-blank line is a `!` header). */
export function looksLikeQif(text: string): boolean {
  const first = /^\s*(\S[^\r\n]*)/.exec(withoutBom(text))?.[1] ?? '';
  return /^!(type:|account\b|option:|clear:)/i.test(first.trim());
}

const year2 = (yy: string) => (Number(yy) < 70 ? `20${yy}` : `19${yy}`);

/**
 * Normalizes a QIF date so the usual date detection can read it: padding spaces go, and two-digit years get their
 * century. Quicken writes `'` before the year from 2000 on (1/5'24), and `/` before a two-digit year for the 1900s;
 * other exporters write 01/05/24 for 2024, so a two-digit year below 70 counts as 20yy.
 */
export function normalizeQifDate(raw: string): string {
  const s = raw.replace(/\s+/g, '');
  const apostrophe = /^(\d{1,2})[/.-](\d{1,2})'(\d{2})$/.exec(s);
  if (apostrophe) return `${apostrophe[1]}/${apostrophe[2]}/20${apostrophe[3]}`;
  const short = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{2})$/.exec(s);
  if (short) return `${short[1]}${short[2]}${short[3]}${short[2]}${year2(short[4]!)}`;
  const long = /^(\d{1,2})'(\d{1,2})'(\d{4})$/.exec(s);
  if (long) return `${long[1]}/${long[2]}/${long[3]}`;
  return s;
}

/** `Cat:Sub/Class` → category and group; `[Account]/Class` → transfer account. */
export function splitQifCategory(raw: string): { category: string; transfer: string | null } {
  const value = raw.trim();
  const transfer = /^\[([^\]]*)\]/.exec(value);
  if (transfer) return { category: '', transfer: transfer[1]!.trim() };
  const slash = value.indexOf('/');
  const category = (slash >= 0 ? value.slice(0, slash) : value).trim();
  return { category: /^--split/i.test(category) ? '' : category, transfer: null };
}

const field = (r: QifRecord, code: string) => r[code]?.[0]?.trim() ?? '';

export function readQif(text: string, name = 'QIF'): Sheet {
  const lines = withoutBom(text).split(/\r\n|\r|\n/);
  const rows: string[][] = [];
  const accounts = new Map<string, SheetAccount>();
  let section: string | null = null;
  let account = '';
  let investment = 0;
  let record: QifRecord = {};
  let splits: string[] = [];
  let inAccountBlock = false;
  /** The account the last `!Account` record named: the following `!Type:` section is its. */
  let named = '';

  const flush = () => {
    const has = Object.keys(record).length > 0;
    if (!has) return;
    if (inAccountBlock) {
      // `!Account` records name the account the next section belongs to (an AutoSwitch list only lists them).
      const accountName = field(record, 'N');
      const type = field(record, 'T').toLowerCase();
      if (accountName) {
        named = accountName;
        const kind = TRANSACTION_TYPES[type] ?? null;
        const known = accounts.get(accountName);
        if (known) known.kind ??= kind;
        else if (type in TRANSACTION_TYPES)
          accounts.set(accountName, { name: accountName, kind, closing: null });
      }
    } else if (section === 'invst') investment++;
    else if (section && section in TRANSACTION_TYPES) {
      const amount = field(record, 'T') || field(record, 'U');
      const own = splitQifCategory(field(record, 'L'));
      let category = own.category;
      let transfer = own.transfer;
      if (splits.length) {
        const parts = splits.map((s) => splitQifCategory(s));
        const cats = new Set(parts.map((p) => p.category || (p.transfer ? `[${p.transfer}]` : '')));
        const only = cats.size === 1 ? parts[0]! : null;
        category = only?.category ?? '';
        transfer = only?.transfer ?? null;
      }
      const parts = category.split(':').map((p) => p.trim());
      const row: string[] = new Array<string>(FIXED_COLUMNS.length).fill('');
      row[FIXED.account] = account;
      row[FIXED.date] = normalizeQifDate(field(record, 'D'));
      row[FIXED.payee] = field(record, 'P');
      row[FIXED.memo] = field(record, 'M');
      row[FIXED.category] = category;
      row[FIXED.group] = parts.length > 1 ? parts[0]! : '';
      row[FIXED.transfer] = transfer && transfer !== account ? `Transfer : ${transfer}` : '';
      row[FIXED.amount] = amount;
      row[FIXED.number] = field(record, 'N');
      rows.push(row);
      // A file of one unnamed account (Quicken's one-account export) still says what kind it is.
      const known = accounts.get(account);
      if (!known)
        accounts.set(account, { name: account, kind: TRANSACTION_TYPES[section] ?? null, closing: null });
      else known.kind ??= TRANSACTION_TYPES[section] ?? null;
    }
    record = {};
    splits = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (line.startsWith('!')) {
      flush();
      const header = line.slice(1).trim().toLowerCase();
      if (header === 'account') {
        inAccountBlock = true;
        section = null;
      } else if (header.startsWith('type:')) {
        if (inAccountBlock && named) account = named;
        inAccountBlock = false;
        section = header.slice(5).trim();
      }
      continue;
    }
    if (line.trim() === '^') {
      flush();
      continue;
    }
    const code = line[0]!;
    const value = line.slice(1);
    if (!inAccountBlock && section && section in TRANSACTION_TYPES) {
      // Split lines: only their categories matter, since the row keeps the total (ADR-0030).
      if (code === 'S') splits.push(value);
      if (code === 'S' || code === 'E' || code === '$' || code === '%') continue;
    }
    (record[code] ??= []).push(value);
  }
  flush();

  return fixedSheet(name, rows, {
    accounts: [...accounts.values()],
    warnings: investment ? [`investment_transactions_skipped:${investment}`] : [],
  });
}
