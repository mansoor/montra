import { describe, expect, it } from 'vitest';
import {
  accountNumberInput,
  holderDrafts,
  holdersChanged,
  holdersLine,
  holdersToSave,
} from '../src/account-holders.js';

// An account's holders (ACC-15) and its full number (ACC-16), as the web and the phone shape them.
describe('account holders', () => {
  const saved = [
    { name: 'Ada Lovelace', memberId: 'm-ada' },
    { name: 'Trust for C.', memberId: null },
  ];

  it('round-trips the saved list through a form', () => {
    expect(holderDrafts(saved)).toEqual([
      { name: 'Ada Lovelace', memberId: 'm-ada' },
      { name: 'Trust for C.', memberId: '' },
    ]);
    expect(holdersChanged(saved, holderDrafts(saved))).toBe(false);
  });

  it('trims, drops blank rows, and leaves a member’s name to the server', () => {
    expect(
      holdersToSave([
        { name: '  Ben  ', memberId: '' },
        { name: '   ', memberId: '' },
        { name: '', memberId: 'm-ada' },
      ]),
    ).toEqual([{ name: 'Ben', memberId: null }, { memberId: 'm-ada' }]);
    expect(holdersChanged(saved, [{ name: 'Ada Lovelace', memberId: 'm-ada' }])).toBe(true);
    expect(holdersChanged([], [{ name: ' ', memberId: '' }])).toBe(false);
  });

  it('reads as one line', () => {
    expect(holdersLine([], 'and')).toBe('');
    expect(holdersLine([{ name: 'Ada' }], 'and')).toBe('Ada');
    expect(holdersLine([{ name: 'Ada' }, { name: 'Ben' }], 'and')).toBe('Ada and Ben');
    expect(holdersLine([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 'and')).toBe('A, B and C');
  });
});

describe('a full account number as typed', () => {
  it('drops spaces and dashes and upper-cases letters', () => {
    expect(accountNumberInput('0012 3456-7890 4321')).toBe('0012345678904321');
    expect(accountNumberInput('gb33 bukb 2020 1555 5555 55')).toBe('GB33BUKB20201555555555');
    expect(accountNumberInput('1234')).toBe('1234');
  });

  it('must end in four digits and be at most 34 long', () => {
    expect(accountNumberInput('123')).toBeNull();
    expect(accountNumberInput('12345ABC')).toBeNull();
    expect(accountNumberInput('1'.repeat(34))).toBe('1'.repeat(34));
    expect(accountNumberInput('1'.repeat(35))).toBeNull();
    expect(accountNumberInput('')).toBeNull();
  });
});
