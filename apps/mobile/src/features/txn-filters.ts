/**
 * Transaction filters on the phone (08 §3, FAM-09): accounts, family members and a date range, with the search box.
 * Pure model; the filter panel renders it. An empty selection means "all", so a cleared filter never hides anything.
 */
import {
  addDays,
  addMonths,
  calendarDate,
  endOfMonth,
  parts,
  startOfMonth,
  type CalendarDate,
} from '@montra/domain';
import type { AccountDto, FamilyMemberDto } from '@montra/schemas';
import type { TransactionQuery } from '@montra/sync';

/** The household: transactions with no family member. Stands in for `null` in a selection. */
export const HOUSEHOLD = 'household';

export const DATE_PRESETS = [
  'any',
  'this_month',
  'last_month',
  'last_90_days',
  'this_year',
  'custom',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export interface TxnFilters {
  accountIds: string[];
  /** Member ids, or `HOUSEHOLD`. */
  memberKeys: string[];
  date: DatePreset;
  /** Used when `date` is `custom`; either end may be open. */
  from: CalendarDate | null;
  to: CalendarDate | null;
}

export const NO_FILTERS: TxnFilters = { accountIds: [], memberKeys: [], date: 'any', from: null, to: null };

/** The inclusive range a preset covers on `today`. */
export function dateRange(f: TxnFilters, today: CalendarDate): { from?: CalendarDate; to?: CalendarDate } {
  switch (f.date) {
    case 'any':
      return {};
    case 'this_month':
      return { from: startOfMonth(today), to: today };
    case 'last_month': {
      const start = startOfMonth(addMonths(today, -1));
      return { from: start, to: endOfMonth(start) };
    }
    case 'last_90_days':
      return { from: addDays(today, -89), to: today };
    case 'this_year':
      return { from: calendarDate(`${parts(today).year}-01-01`), to: today };
    case 'custom': {
      // A reversed range is read the way it was meant.
      const [from, to] = f.from && f.to && f.from > f.to ? [f.to, f.from] : [f.from, f.to];
      return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
  }
}

export function queryFor(f: TxnFilters, search: string, today: CalendarDate): TransactionQuery {
  return {
    ...(search.trim() ? { search } : {}),
    ...(f.accountIds.length ? { accountIds: f.accountIds } : {}),
    ...(f.memberKeys.length ? { memberIds: f.memberKeys.map((k) => (k === HOUSEHOLD ? null : k)) } : {}),
    ...dateRange(f, today),
  };
}

const dateOn = (f: TxnFilters) => f.date !== 'any' && (f.date !== 'custom' || Boolean(f.from || f.to));

/** For the badge on the filter button: each chosen account and member, and the date range. */
export const activeCount = (f: TxnFilters): number =>
  f.accountIds.length + f.memberKeys.length + (dateOn(f) ? 1 : 0);

export const toggle = (list: readonly string[], id: string): string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/** Turns a whole group on or off, keeping the rest of the selection. */
export const setAll = (list: readonly string[], ids: readonly string[], on: boolean): string[] =>
  on ? [...list, ...ids.filter((id) => !list.includes(id))] : list.filter((x) => !ids.includes(x));

export function groupState(list: readonly string[], ids: readonly string[]): 'all' | 'some' | 'none' {
  const n = ids.filter((id) => list.includes(id)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

export interface AccountGroup {
  kind: string;
  accounts: AccountDto[];
}

/** Open, visible accounts by kind, kinds in the order they first appear and accounts by name. */
export function accountGroups(accounts: readonly AccountDto[]): AccountGroup[] {
  const groups = new Map<string, AccountDto[]>();
  for (const a of accounts) {
    if (a.archived || a.hidden) continue;
    groups.set(a.kind, [...(groups.get(a.kind) ?? []), a]);
  }
  return [...groups].map(([kind, list]) => ({
    kind,
    accounts: [...list].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** Active members, then the household. */
export function memberChoices(
  members: readonly FamilyMemberDto[],
): Array<{ key: string; name: string | null }> {
  return [
    ...members.filter((m) => m.status === 'active').map((m) => ({ key: m.id, name: m.name })),
    { key: HOUSEHOLD, name: null },
  ];
}
