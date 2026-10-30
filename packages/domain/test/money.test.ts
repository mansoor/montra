import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  add,
  convert,
  CurrencyMismatchError,
  formatMoney,
  minorUnits,
  money,
  parseDecimal,
  parseMoney,
  sum,
  toDecimalString,
} from '../src/index.js';

describe('currency', () => {
  it('knows minor units per ISO 4217 (CUR-02)', () => {
    expect(minorUnits('USD')).toBe(2);
    expect(minorUnits('JPY')).toBe(0);
    expect(minorUnits('KWD')).toBe(3);
    expect(() => money(1, 'XYZ')).toThrow(RangeError);
  });
});

describe('parseMoney', () => {
  it.each([
    ['12.34', 'USD', 1234n],
    ['-0.5', 'USD', -50n],
    ['(5.00)', 'USD', -500n],
    ['1,234.56', 'USD', 123456n],
    ['1234', 'JPY', 1234n],
    ['1.234', 'KWD', 1234n],
    ['12.340', 'USD', 1234n],
    ['5.00-', 'USD', -500n],
  ])('%s %s → %s', (input, ccy, expected) => {
    expect(parseMoney(input, ccy).amount).toBe(expected);
  });

  it('supports comma decimals (IMP-03)', () => {
    expect(parseMoney('1.234,56', 'EUR', { decimal: ',' }).amount).toBe(123456n);
    expect(parseMoney('1 234,5', 'EUR', { decimal: ',', group: ' ' }).amount).toBe(123450n);
  });

  it('rejects excess precision and garbage', () => {
    expect(() => parseMoney('1.234', 'USD')).toThrow(RangeError);
    expect(() => parseMoney('1.5', 'JPY')).toThrow(RangeError);
    expect(() => parseMoney('12a', 'USD')).toThrow(SyntaxError);
    expect(() => parseMoney('', 'USD')).toThrow(SyntaxError);
  });

  it('round-trips through toDecimalString', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.constantFrom('USD', 'JPY', 'KWD'),
        (n, c) => {
          const m = money(n, c);
          expect(parseMoney(toDecimalString(m), c)).toEqual(m);
        },
      ),
    );
  });
});

describe('arithmetic', () => {
  it('refuses to mix currencies', () => {
    expect(() => add(money(1, 'USD'), money(1, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => sum([money(1, 'USD'), money(1, 'EUR')], 'USD')).toThrow(CurrencyMismatchError);
  });

  it('converts across exponents with half-even rounding', () => {
    // €40.00 at 1.09 USD/EUR = $43.60
    expect(convert(money(4000, 'EUR'), 'USD', parseDecimal('1.09'))).toEqual(money(4360, 'USD'));
    // ¥1,000 at 0.0067 USD/JPY = $6.70
    expect(convert(money(1000, 'JPY'), 'USD', parseDecimal('0.0067'))).toEqual(money(670, 'USD'));
    // 10.000 KWD at 3.25 = $32.50
    expect(convert(money(10000, 'KWD'), 'USD', parseDecimal('3.25'))).toEqual(money(3250, 'USD'));
    // half-even: 0.125 → 0.12, 0.135 → 0.14
    expect(convert(money(125, 'EUR'), 'USD', parseDecimal('0.1')).amount).toBe(12n);
    expect(convert(money(135, 'EUR'), 'USD', parseDecimal('0.1')).amount).toBe(14n);
  });
});

describe('formatMoney (CUR-10)', () => {
  it('formats exactly per locale', () => {
    expect(formatMoney(money(123456, 'USD'))).toBe('$1,234.56');
    expect(formatMoney(money(-500, 'USD'), { style: 'accounting' })).toBe('($5.00)');
    expect(formatMoney(money(123456, 'EUR'), { locale: 'de-DE' })).toBe('1.234,56 €');
    expect(formatMoney(money(1234, 'JPY'), { locale: 'ja-JP' })).toMatch(/1,234/);
    // Beyond float precision: 2^60 cents must not lose digits.
    expect(formatMoney(money(2n ** 60n, 'USD'))).toBe('$11,529,215,046,068,469.76');
  });
});
