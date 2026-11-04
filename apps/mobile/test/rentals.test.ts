import { describe, expect, it } from 'vitest';
import type { AccountDto, RentRollDto } from '@montra/schemas';
import { rentAccounts, rollInOrder } from '../src/features/rentals';

const row = (propertyName: string, open: string) =>
  ({ propertyName, unitLabel: 'Main', open }) as RentRollDto['rows'][number];
const account = (id: string, kind: string, entityId: string) => ({ id, kind, entityId }) as AccountDto;

describe('rollInOrder', () => {
  it('puts the largest unpaid first, then the rest by name', () => {
    const out = rollInOrder([row('B', '0'), row('C', '100'), row('A', '0'), row('D', '900')]);
    expect(out.map((r) => r.propertyName)).toEqual(['D', 'C', 'A', 'B']);
  });
});

describe('rentAccounts', () => {
  it('keeps accounts rent can land in, with the portfolio own first', () => {
    const out = rentAccounts(
      [
        account('personal', 'checking', 'p'),
        account('card', 'credit_card', 'r'),
        account('loan', 'mortgage', 'r'),
        account('rental', 'savings', 'r'),
      ],
      'r',
    );
    expect(out.map((a) => a.id)).toEqual(['rental', 'personal']);
  });
});
