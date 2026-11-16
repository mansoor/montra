import { describe, expect, it } from 'vitest';
import type { ScanBillDetectedDto } from '@montra/api-client';
import {
  blankDraft,
  canWriteBooks,
  checkBillDraft,
  draftFromReading,
  matchNote,
  providerChoices,
  waitForScan,
} from './household-bills';

const reading = (over: Partial<ScanBillDetectedDto> = {}): ScanBillDetectedDto => ({
  billerName: 'XFINITY',
  kind: 'internet_tv',
  accountLast4: '4321',
  billerId: 'b1',
  candidates: [{ billerId: 'b1', name: 'Comcast', categoryId: 'c1', reason: 'account' }],
  memberId: null,
  amount: '11245',
  currency: 'USD',
  dueDate: '2026-12-01',
  billDate: '2026-11-10',
  periodStart: null,
  periodEnd: null,
  ...over,
});

describe('canWriteBooks', () => {
  const ws = (role: string, access: 'read' | 'write' = 'write') => ({
    role,
    entities: [{ id: 'e1', access }],
  });
  it('lets everyone but a viewer add bills to books they can write', () => {
    for (const role of ['owner', 'admin', 'partner', 'accountant', 'member'])
      expect(canWriteBooks(ws(role), 'e1')).toBe(true);
    expect(canWriteBooks(ws('viewer'), 'e1')).toBe(false);
    expect(canWriteBooks(ws('member', 'read'), 'e1')).toBe(false);
  });
});

describe('waitForScan', () => {
  it('checks until the scan is no longer reading', async () => {
    const statuses = ['reading', 'reading', 'ready'];
    const slept: number[] = [];
    const done = await waitForScan(
      async () => ({ status: statuses.shift()! }),
      10,
      1000,
      async (ms) => void slept.push(ms),
    );
    expect(done).toEqual({ status: 'ready' });
    expect(slept).toEqual([10, 10]);
  });

  it('gives up with null after the limit', async () => {
    let calls = 0;
    const done = await waitForScan(
      async () => {
        calls += 1;
        return { status: 'reading' };
      },
      10,
      30,
      async () => {},
    );
    expect(done).toBeNull();
    expect(calls).toBe(4);
  });
});

describe('draftFromReading', () => {
  const base = { ...blankDraft('utilities'), billerId: 'first' };

  it('fills in the provider, amount and dates read', () => {
    expect(draftFromReading(reading(), base)).toEqual({
      billerId: 'b1',
      newName: 'XFINITY',
      categoryId: 'utilities',
      amount: '112.45',
      dueDate: '2026-12-01',
      billDate: '2026-11-10',
    });
  });

  it('takes the first candidate, else a new provider named as printed', () => {
    expect(draftFromReading(reading({ billerId: null }), base).billerId).toBe('b1');
    const none = draftFromReading(reading({ billerId: null, candidates: [] }), base);
    expect(none).toMatchObject({ billerId: '', newName: 'XFINITY' });
  });

  it('leaves out what was not read, or not a date', () => {
    const d = draftFromReading(reading({ amount: null, dueDate: '12/01/2026', billDate: null }), base);
    expect(d).toMatchObject({ amount: '', dueDate: '', billDate: '' });
    expect(draftFromReading(null, base)).toBe(base);
  });
});

describe('matchNote', () => {
  it('says how the provider was found', () => {
    expect(matchNote(reading())).toEqual({
      key: 'account',
      text: 'Matched to Comcast by the account number.',
    });
    const byName = reading({
      candidates: [{ billerId: 'b1', name: 'Comcast', categoryId: 'c1', reason: 'name' }],
    });
    expect(matchNote(byName)?.key).toBe('name');
    expect(matchNote(reading({ billerId: null, candidates: [] }))?.key).toBe('none');
    expect(matchNote(null)).toBeNull();
  });
});

describe('providerChoices', () => {
  it('lists active providers and adds a matched one that is not listed', () => {
    const billers = [
      { id: 'b2', name: 'SDG&E', entityId: 'e1', archived: false },
      { id: 'b3', name: 'Old', entityId: 'e1', archived: true },
    ];
    expect(providerChoices(billers, reading())).toEqual([
      { id: 'b2', name: 'SDG&E', entityId: 'e1' },
      { id: 'b1', name: 'Comcast', entityId: null },
    ]);
    expect(providerChoices(billers, null)).toHaveLength(1);
  });
});

describe('checkBillDraft', () => {
  const ok = { ...blankDraft('c1'), billerId: 'b1', amount: '84.12', dueDate: '2026-12-01' };

  it('gives the amount in minor units and the dates', () => {
    expect(checkBillDraft(ok, 'USD')).toEqual({
      ok: true,
      amount: '8412',
      dueDate: '2026-12-01',
      billDate: null,
    });
    expect(checkBillDraft({ ...ok, amount: '1,234.5', billDate: '2026-11-15' }, 'USD')).toEqual({
      ok: true,
      amount: '123450',
      dueDate: '2026-12-01',
      billDate: '2026-11-15',
    });
  });

  it('names each field that is missing or wrong', () => {
    const r = checkBillDraft(
      { billerId: '', newName: ' ', categoryId: '', amount: '0', dueDate: '', billDate: '2026-02-30' },
      'USD',
    );
    expect(r).toEqual({
      ok: false,
      errors: {
        newName: "Enter the provider's name",
        categoryId: 'Choose a category for the new provider',
        amount: 'Enter an amount above zero',
        dueDate: 'Enter the due date',
        billDate: 'Enter a real date',
      },
    });
    const bad = checkBillDraft({ ...ok, amount: 'abc', dueDate: '2026-13-01' }, 'USD');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['amount', 'dueDate']);
  });

  it('accepts a new provider with a name and category', () => {
    expect(checkBillDraft({ ...ok, billerId: '', newName: 'SDG&E' }, 'USD').ok).toBe(true);
  });
});
