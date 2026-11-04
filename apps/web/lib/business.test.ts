import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import {
  bpsToPercent,
  buildLines,
  emptyRow,
  liveTotals,
  percentToBps,
  rangeOf,
  type InvoiceRow,
} from './business';

const row = (over: Partial<InvoiceRow>): InvoiceRow => ({
  ...emptyRow('a', 'cat'),
  description: 'Design',
  unitPrice: '100.00',
  ...over,
});

describe('percentToBps', () => {
  it('reads percentages exactly', () => {
    expect(percentToBps('8.25')).toBe(825);
    expect(percentToBps('8.2')).toBe(820);
    expect(percentToBps('100')).toBe(10000);
    expect(percentToBps('')).toBe(0);
    expect(percentToBps(' 7 ')).toBe(700);
  });

  it('refuses what is not a percentage', () => {
    expect(percentToBps('8.255')).toBeNull();
    expect(percentToBps('101')).toBeNull();
    expect(percentToBps('abc')).toBeNull();
    expect(percentToBps('-1')).toBeNull();
  });

  it('goes back without float noise', () => {
    expect(bpsToPercent(825)).toBe('8.25');
    expect(bpsToPercent(820)).toBe('8.2');
    expect(bpsToPercent(700)).toBe('7');
    expect(bpsToPercent(0)).toBe('');
    expect(bpsToPercent(5)).toBe('0.05');
  });
});

describe('liveTotals', () => {
  it('adds what has been typed, ignoring rows that do not parse yet', () => {
    const t = liveTotals(
      [
        row({ quantity: '1.5', taxRate: '8.25' }),
        row({ key: 'b', unitPrice: 'abc' }),
        row({ key: 'c', unitPrice: '25.50', quantity: '2' }),
      ],
      'USD',
    );
    expect(t).toEqual({ subtotal: 20100n, tax: 1238n, total: 21338n });
  });
});

describe('buildLines', () => {
  it('sends minor units and basis points', () => {
    expect(buildLines([row({ quantity: '1.5', taxRate: '8.25' })], 'USD')).toEqual({
      ok: true,
      lines: [
        {
          description: 'Design',
          quantity: '1.5',
          unitPrice: '10000',
          taxRateBps: 825,
          incomeAccountId: 'cat',
        },
      ],
    });
  });

  it('points at each field that is wrong', () => {
    const res = buildLines(
      [
        row({ key: 'a', description: ' ', quantity: '0' }),
        row({ key: 'b', unitPrice: 'x', taxRate: '200', quantity: '1.2345' }),
        row({ key: 'c', unitPrice: '-5' }),
      ],
      'USD',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(Object.keys(res.errors).sort()).toEqual(
        ['a.description', 'a.quantity', 'b.quantity', 'b.taxRate', 'b.unitPrice', 'c.unitPrice'].sort(),
      );
    }
  });
});

describe('rangeOf', () => {
  const today = calendarDate('2026-11-04');

  it('gives the report ranges', () => {
    expect(rangeOf('month', today)).toEqual({ from: '2026-11-01', to: today });
    expect(rangeOf('quarter', today)).toEqual({ from: '2026-10-01', to: today });
    expect(rangeOf('quarter', calendarDate('2026-03-31')).from).toBe('2026-01-01');
    expect(rangeOf('ytd', today)).toEqual({ from: '2026-01-01', to: today });
    expect(rangeOf('last_year', today)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
});
