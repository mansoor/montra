import { describe, expect, it } from 'vitest';
import { WHEEL_CHOICES, wheelChoices, wheelLayout, wheelRoute } from '../src/features/add-wheel';

// The Add wheel (ADR-0048): what it offers and where.
describe('the Add wheel', () => {
  const all = { record: true, importFiles: true, setUp: true };

  it('offers what the login can use, in order', () => {
    expect(wheelChoices(all)).toEqual(['transaction', 'receipt', 'statement', 'bill', 'payslip']);
    // A member records but doesn't import or set up.
    expect(wheelChoices({ record: true, importFiles: false, setUp: false })).toEqual([
      'transaction',
      'receipt',
      'bill',
    ]);
    expect(wheelChoices({ record: false, importFiles: false, setUp: false })).toEqual([]);
    expect(
      wheelChoices(
        all,
        WHEEL_CHOICES.filter((c) => c !== 'bill'),
      ),
    ).not.toContain('bill');
  });

  it('opens each choice where it is captured', () => {
    expect(WHEEL_CHOICES.map(wheelRoute)).toEqual([
      '/capture',
      '/receipt-capture',
      '/import?scan=1',
      '/bills/capture',
      '/payslips/capture',
    ]);
  });

  it('spreads the choices over the arc above the +, left to right', () => {
    const five = wheelLayout(5, 100);
    expect(five).toHaveLength(5);
    expect(five[0]!.x).toBeLessThan(0);
    expect(five[2]).toEqual({ x: 0, y: 100 });
    expect(five[4]!.x).toBeGreaterThan(0);
    // Every choice sits above the +, and the outer ones clear the tab bar.
    expect(Math.min(...five.map((p) => p.y))).toBeGreaterThan(25);
    expect(wheelLayout(1, 100)).toEqual([{ x: 0, y: 100 }]);
    expect(wheelLayout(0, 100)).toEqual([]);
  });
});
