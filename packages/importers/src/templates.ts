/**
 * Mappings for exports of other apps (IMP-13). Their headers are stable, so they match by header names and
 * skip heuristics. Multi-account exports carry an account column; the importer filters to one account.
 * Header names compare without case, underscores or extra spaces ("Category_Group" is "category group").
 */
import { detectDecimalSeparator } from './amounts.js';
import { detectDateFormat } from './dates.js';
import type { ColumnMapping, MappingProposal } from './mapping.js';
import type { Sheet } from './grid.js';

interface Template {
  id: string;
  name: string;
  required: string[];
  build(
    col: (name: string) => number | undefined,
    values: (i: number) => string[],
  ): Omit<ColumnMapping, 'headerRow' | 'dataStart' | 'dateFormat' | 'decimal'> & {
    accountColumn?: number;
    /** The category's group, when the export names it (switching from another app creates groups with it). */
    groupColumn?: number;
  };
}

export const APP_TEMPLATES: Template[] = [
  {
    id: 'ynab',
    name: 'YNAB register export',
    required: ['account', 'date', 'payee', 'memo', 'outflow', 'inflow'],
    build: (col) => ({
      date: col('date')!,
      description: [col('memo')!],
      payee: col('payee')!,
      debit: col('outflow')!,
      credit: col('inflow')!,
      category: col('category'),
      sign: 'normal',
      openingPayees: ['Starting Balance'],
      accountColumn: col('account'),
      groupColumn: col('category group'),
    }),
  },
  {
    id: 'actual',
    name: 'Actual Budget export',
    required: ['account', 'date', 'payee', 'notes', 'category', 'amount', 'split amount'],
    build: (col) => ({
      date: col('date')!,
      description: [col('notes')!],
      payee: col('payee')!,
      amount: col('amount')!,
      category: col('category'),
      sign: 'normal',
      accountColumn: col('account'),
      groupColumn: col('category group'),
    }),
  },
  {
    id: 'lunch_money',
    name: 'Lunch Money export',
    required: ['date', 'payee', 'amount', 'category', 'original name'],
    build: (col) => ({
      date: col('date')!,
      description: [col('original name')!, ...(col('notes') !== undefined ? [col('notes')!] : [])],
      payee: col('payee')!,
      amount: col('amount')!,
      category: col('category'),
      sign: 'normal',
      accountColumn: col('account name') ?? col('account'),
      groupColumn: col('category group'),
    }),
  },
  {
    id: 'tiller',
    name: 'Tiller transactions sheet',
    required: ['date', 'description', 'category', 'amount', 'account', 'full description'],
    build: (col) => ({
      date: col('date')!,
      description: [col('full description')!, ...(col('note') !== undefined ? [col('note')!] : [])],
      payee: col('merchant name') ?? col('description')!,
      amount: col('amount')!,
      category: col('category'),
      sign: 'normal',
      accountColumn: col('account'),
    }),
  },
  {
    id: 'goodbudget',
    name: 'Goodbudget export',
    required: ['date', 'envelope', 'account', 'name', 'amount'],
    build: (col) => ({
      date: col('date')!,
      description: [col('notes') ?? col('name')!],
      payee: col('name')!,
      amount: col('amount')!,
      category: col('envelope'),
      sign: 'normal',
      accountColumn: col('account'),
    }),
  },
  {
    id: 'empower',
    name: 'Empower transactions export',
    required: ['date', 'account', 'description', 'category', 'tags', 'amount'],
    build: (col) => ({
      date: col('date')!,
      description: [col('description')!],
      payee: col('description')!,
      amount: col('amount')!,
      category: col('category'),
      sign: 'normal',
      accountColumn: col('account'),
    }),
  },
  {
    id: 'mint',
    name: 'Mint transactions export',
    required: ['date', 'description', 'original description', 'amount', 'transaction type', 'account name'],
    build: (col, values) => ({
      date: col('date')!,
      description: [col('original description')!],
      payee: col('description')!,
      amount: col('amount')!,
      direction: {
        column: col('transaction type')!,
        debitValues: [...new Set(values(col('transaction type')!).filter((v) => /^debit$/i.test(v)))].concat(
          'debit',
        ),
      },
      category: col('category'),
      sign: 'normal',
      accountColumn: col('account name'),
    }),
  },
  {
    id: 'monarch',
    name: 'Monarch Money export',
    required: ['date', 'merchant', 'category', 'account', 'original statement', 'amount'],
    build: (col) => ({
      date: col('date')!,
      description: [col('original statement')!],
      payee: col('merchant')!,
      amount: col('amount')!,
      category: col('category'),
      sign: 'normal',
      accountColumn: col('account'),
    }),
  },
  {
    id: 'stessa',
    name: 'Stessa transactions export',
    required: ['date', 'name', 'category', 'sub-category', 'amount', 'property'],
    build: (col) => ({
      date: col('date')!,
      description: [col('name')!, ...(col('notes') !== undefined ? [col('notes')!] : [])],
      amount: col('amount')!,
      category: col('sub-category'),
      sign: 'normal',
      accountColumn: col('account'),
    }),
  },
  {
    id: 'quicken',
    name: 'Quicken CSV export',
    required: ['date', 'payee', 'category', 'amount'],
    build: (col) => ({
      date: col('date')!,
      description: [col('memo') ?? col('notes') ?? col('payee')!],
      payee: col('payee')!,
      amount: col('amount')!,
      category: col('category'),
      sign: 'normal',
      accountColumn: col('account'),
    }),
  },
];

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');

/**
 * A file the templates don't know (Copilot, Rocket Money, PocketSmith, Simplifi, …): its account column, if a header
 * names one. Switching from another app splits such a file by it.
 */
export function findAccountColumn(header: readonly string[]): number | null {
  const names = header.map(norm);
  for (const n of ['account', 'account name', 'account title']) {
    const i = names.indexOf(n);
    if (i >= 0) return i;
  }
  return null;
}

/** Matches a sheet against the app templates; returns a proposal plus the account values found, if any. */
export function matchTemplate(
  sheet: Sheet,
  accountFilter?: string,
):
  | (MappingProposal & {
      templateId: string;
      accounts: string[];
      accountColumn: number | null;
      groupColumn: number | null;
    })
  | null {
  for (let h = 0; h < Math.min(sheet.rows.length, 5); h++) {
    const header = sheet.rows[h]!.map(norm);
    for (const t of APP_TEMPLATES) {
      if (!t.required.every((r) => header.includes(r))) continue;
      const col = (name: string) => {
        const i = header.indexOf(name);
        return i >= 0 ? i : undefined;
      };
      const data = sheet.rows.slice(h + 1);
      const values = (i: number) => data.map((r) => (r[i] ?? '').trim()).filter(Boolean);
      const built = t.build(col, values);
      const { accountColumn, groupColumn, ...rest } = built;
      const accounts = accountColumn !== undefined ? [...new Set(values(accountColumn))] : [];
      const dates = detectDateFormat(values(built.date));
      const moneyCol = built.amount ?? built.debit ?? built.credit!;
      const mapping: ColumnMapping = {
        ...rest,
        headerRow: h,
        dataStart: h + 1,
        dateFormat: dates?.format ?? 'YYYY-MM-DD',
        decimal: detectDecimalSeparator([
          ...values(moneyCol),
          ...(built.credit !== undefined ? values(built.credit) : []),
        ]),
        ...(accountColumn !== undefined && (accountFilter || accounts.length === 1)
          ? { filter: { column: accountColumn, values: [accountFilter ?? accounts[0]!] } }
          : {}),
      };
      const warnings = accounts.length > 1 && !accountFilter ? ['multiple_accounts_choose_one'] : [];
      if (dates?.ambiguous) warnings.push('ambiguous_date_format');
      return {
        mapping,
        confidence: warnings.length ? 0.7 : 0.95,
        source: 'reference',
        warnings,
        header: sheet.rows[h]!,
        templateId: t.id,
        accounts,
        accountColumn: accountColumn ?? null,
        groupColumn: groupColumn ?? null,
      };
    }
  }
  return null;
}
