/**
 * The accounts list, grouped by kind with totals, for web and phone. Currencies are never added together: each stays on its own line, as on
 * Home, so nothing here depends on a rate.
 */

export interface SummarizableAccount {
  name: string;
  kind: string;
  type: 'asset' | 'liability';
  currency: string;
  archived: boolean;
  hidden: boolean;
  /** Natural balance: held for assets, owed for liabilities. */
  balance: { amount: string };
}

export interface CurrencyTotal {
  currency: string;
  amount: bigint;
}

export interface AccountKindGroup<T> {
  kind: string;
  /** What the group's accounts are. A liability's total is what's owed. */
  type: 'asset' | 'liability';
  accounts: T[];
  totals: CurrencyTotal[];
}

export interface AccountsSummary<T> {
  groups: AccountKindGroup<T>[];
  /** Everything held. */
  assets: CurrencyTotal[];
  /** Everything owed, as a positive number. */
  liabilities: CurrencyTotal[];
  /** Held less owed. */
  net: CurrencyTotal[];
}

/** What you have first, then what you owe, most everyday first. */
const KIND_ORDER = [
  'checking',
  'savings',
  'cash',
  'investment',
  'asset',
  'credit_card',
  'line_of_credit',
  'loan',
  'mortgage',
  'liability',
];

const rank = (kind: string) => {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
};

function totalsOf(entries: { currency: string; amount: bigint }[]): CurrencyTotal[] {
  const totals = new Map<string, bigint>();
  for (const e of entries) totals.set(e.currency, (totals.get(e.currency) ?? 0n) + e.amount);
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount }));
}

export function summarizeAccounts<T extends SummarizableAccount>(accounts: readonly T[]): AccountsSummary<T> {
  const shown = accounts.filter((a) => !a.archived && !a.hidden);
  const entry = (a: T, sign = 1n) => ({ currency: a.currency, amount: sign * BigInt(a.balance.amount) });
  const kinds = [...new Set(shown.map((a) => a.kind))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  return {
    groups: kinds.map((kind) => {
      const members = shown.filter((a) => a.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
      return {
        kind,
        type: members[0]!.type,
        accounts: members,
        totals: totalsOf(members.map((a) => entry(a))),
      };
    }),
    assets: totalsOf(shown.filter((a) => a.type === 'asset').map((a) => entry(a))),
    liabilities: totalsOf(shown.filter((a) => a.type === 'liability').map((a) => entry(a))),
    net: totalsOf(shown.map((a) => entry(a, a.type === 'asset' ? 1n : -1n))),
  };
}
