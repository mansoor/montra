import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import type { AccountDto, GoalDto } from '@montra/schemas';
import { goalDraft, goalPatch, linkableAccounts } from '../src/features/goals';

const goal = (over: Partial<GoalDto> = {}): GoalDto => ({
  id: 'g1',
  entityId: 'e1',
  memberId: null,
  name: 'Car insurance',
  type: 'sinking_fund',
  target: '120000',
  dueDate: calendarDate('2027-03-15'),
  categoryId: 'c1',
  strategy: null,
  linkedAccountIds: [],
  extraPayment: null,
  currency: 'USD',
  progress: {
    saved: '0',
    percent: 0,
    monthlyNeeded: '40000',
    monthlyAverage: '0',
    projectedCompletion: null,
    onTrack: null,
  },
  payoff: null,
  archived: false,
  version: 3,
  ...over,
});

const account = (id: string, over: Partial<AccountDto> = {}) =>
  ({ id, entityId: 'e1', type: 'asset', archived: false, name: id, ...over }) as AccountDto;

describe('editing a goal on the phone (BUD-07, BUD-08)', () => {
  it('pre-fills the sheet from the goal', () => {
    expect(goalDraft(goal())).toEqual({
      name: 'Car insurance',
      memberId: null,
      target: '1200.00',
      dueDate: calendarDate('2027-03-15'),
      strategy: 'avalanche',
      extraPayment: '',
      linkedAccountIds: [],
    });
  });

  it('sends the edited fields with the version, and debt fields only for a payoff plan', () => {
    const d = { ...goalDraft(goal()), name: ' Car insurance 2027 ', target: '1500,50' };
    expect(goalPatch(goal(), d)).toEqual({
      ok: true,
      patch: {
        name: 'Car insurance 2027',
        memberId: null,
        target: '150050',
        dueDate: calendarDate('2027-03-15'),
        linkedAccountIds: [],
        version: 3,
      },
    });
    const debt = goal({
      type: 'debt_payoff',
      target: null,
      dueDate: null,
      strategy: 'avalanche',
      linkedAccountIds: ['card'],
      extraPayment: '10000',
    });
    const r = goalPatch(debt, { ...goalDraft(debt), strategy: 'snowball', extraPayment: '' });
    expect(r).toMatchObject({ ok: true, patch: { strategy: 'snowball', extraPayment: null, target: null } });
  });

  it('says what to fix before calling the API', () => {
    const g = goal();
    const d = goalDraft(g);
    expect(goalPatch(g, { ...d, name: '  ' })).toEqual({ ok: false, error: 'name' });
    expect(goalPatch(g, { ...d, target: 'abc' })).toEqual({ ok: false, error: 'amount' });
    expect(goalPatch(g, { ...d, target: '0' })).toEqual({ ok: false, error: 'amount' });
    expect(goalPatch(g, { ...d, dueDate: '2027-02-30' })).toEqual({ ok: false, error: 'date' });
    expect(goalPatch(g, { ...d, dueDate: '' })).toEqual({ ok: false, error: 'sinking_fund' });
    expect(goalPatch(goal({ type: 'savings' }), { ...d, dueDate: '', target: '' })).toMatchObject({
      ok: true,
      patch: { dueDate: null, target: null },
    });
    const debt = goal({ type: 'debt_payoff', strategy: 'snowball', linkedAccountIds: ['card'] });
    expect(goalPatch(debt, { ...goalDraft(debt), linkedAccountIds: [] })).toEqual({
      ok: false,
      error: 'debts',
    });
  });

  it('offers savings or debts of the same books, keeping an archived one the goal still links', () => {
    const accounts = [
      account('savings'),
      account('old', { archived: true }),
      account('linked-old', { archived: true }),
      account('card', { type: 'liability' }),
      account('business', { entityId: 'e2' }),
    ];
    const g = goal({ type: 'savings', linkedAccountIds: ['linked-old'] });
    expect(linkableAccounts(accounts, g).map((a) => a.id)).toEqual(['savings', 'linked-old']);
    expect(linkableAccounts(accounts, goal({ type: 'debt_payoff' })).map((a) => a.id)).toEqual(['card']);
  });
});
