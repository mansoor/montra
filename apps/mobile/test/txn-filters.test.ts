import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import type { AccountDto, FamilyMemberDto } from '@montra/schemas';
import {
  accountGroups,
  activeCount,
  dateRange,
  groupState,
  HOUSEHOLD,
  memberChoices,
  NO_FILTERS,
  queryFor,
  setAll,
  toggle,
  type TxnFilters,
} from '../src/features/txn-filters';

const today = calendarDate('2026-11-09');
const f = (over: Partial<TxnFilters>): TxnFilters => ({ ...NO_FILTERS, ...over });

describe('transaction filters: dates', () => {
  it('turns presets into inclusive ranges', () => {
    expect(dateRange(f({ date: 'any' }), today)).toEqual({});
    expect(dateRange(f({ date: 'this_month' }), today)).toEqual({ from: '2026-11-01', to: '2026-11-09' });
    expect(dateRange(f({ date: 'last_month' }), today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(dateRange(f({ date: 'last_90_days' }), today)).toEqual({ from: '2026-08-12', to: '2026-11-09' });
    expect(dateRange(f({ date: 'this_year' }), today)).toEqual({ from: '2026-01-01', to: '2026-11-09' });
  });

  it('crosses years and month lengths', () => {
    expect(dateRange(f({ date: 'last_month' }), calendarDate('2027-01-15'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(dateRange(f({ date: 'last_month' }), calendarDate('2028-03-31'))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('takes a custom range open at either end, and reads a reversed one the way it was meant', () => {
    const from = calendarDate('2026-10-05');
    const to = calendarDate('2026-10-20');
    expect(dateRange(f({ date: 'custom', from, to }), today)).toEqual({ from, to });
    expect(dateRange(f({ date: 'custom', from: to, to: from }), today)).toEqual({ from, to });
    expect(dateRange(f({ date: 'custom', from }), today)).toEqual({ from });
    expect(dateRange(f({ date: 'custom' }), today)).toEqual({});
  });
});

describe('transaction filters: query and badge', () => {
  it('leaves out everything that is cleared', () => {
    expect(queryFor(NO_FILTERS, '  ', today)).toEqual({});
    expect(activeCount(NO_FILTERS)).toBe(0);
  });

  it('combines accounts, members (the household as null), dates and search', () => {
    const filters = f({ accountIds: ['a1', 'a2'], memberKeys: ['m1', HOUSEHOLD], date: 'this_month' });
    expect(queryFor(filters, 'coffee', today)).toEqual({
      search: 'coffee',
      accountIds: ['a1', 'a2'],
      memberIds: ['m1', null],
      from: '2026-11-01',
      to: '2026-11-09',
    });
    expect(activeCount(filters)).toBe(5);
  });

  it("doesn't count a custom range with no dates", () => {
    expect(activeCount(f({ date: 'custom' }))).toBe(0);
    expect(activeCount(f({ date: 'custom', to: calendarDate('2026-10-01') }))).toBe(1);
  });
});

describe('transaction filters: choosing', () => {
  it('toggles one, and a whole group at once', () => {
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
    expect(setAll(['x'], ['a', 'b'], true)).toEqual(['x', 'a', 'b']);
    expect(setAll(['x', 'a'], ['a', 'b'], true)).toEqual(['x', 'a', 'b']);
    expect(setAll(['x', 'a', 'b'], ['a', 'b'], false)).toEqual(['x']);
    expect(groupState(['a'], ['a', 'b'])).toBe('some');
    expect(groupState(['a', 'b'], ['a', 'b'])).toBe('all');
    expect(groupState(['x'], ['a', 'b'])).toBe('none');
  });

  it('groups open, visible accounts by kind, by name', () => {
    const acct = (id: string, kind: string, name: string, over: Partial<AccountDto> = {}) =>
      ({ id, kind, name, archived: false, hidden: false, ...over }) as AccountDto;
    const groups = accountGroups([
      acct('1', 'checking', 'Main'),
      acct('2', 'credit_card', 'Visa'),
      acct('3', 'checking', 'Joint'),
      acct('4', 'credit_card', 'Old card', { archived: true }),
      acct('5', 'savings', 'Hidden', { hidden: true }),
    ]);
    expect(groups.map((g) => [g.kind, g.accounts.map((a) => a.name)])).toEqual([
      ['checking', ['Joint', 'Main']],
      ['credit_card', ['Visa']],
    ]);
  });

  it('offers active members, then the household', () => {
    const m = (id: string, name: string, status: 'active' | 'inactive') =>
      ({ id, name, status }) as FamilyMemberDto;
    expect(memberChoices([m('m1', 'Sam', 'active'), m('m2', 'Ex', 'inactive')])).toEqual([
      { key: 'm1', name: 'Sam' },
      { key: HOUSEHOLD, name: null },
    ]);
  });
});
