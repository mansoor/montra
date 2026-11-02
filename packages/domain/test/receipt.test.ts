import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  allocateSigned,
  convertGroupsAtCharge,
  decimalToString,
  deviationBps,
  fitToCharged,
  FX_MATCH_TOLERANCE_BPS,
  groupReceipt,
  impliedRate,
  mulRound,
  validateReceipt,
  type ReceiptLineAmounts,
  type ReceiptTotals,
} from '../src/index.js';

const line = (key: string, lineTotal: bigint, taxable: boolean, discount = 0n): ReceiptLineAmounts => ({
  key,
  lineTotal,
  discount,
  taxable,
});
const totals = (t: Partial<ReceiptTotals>): ReceiptTotals => ({
  tax: 0n,
  discount: 0n,
  fees: 0n,
  tip: 0n,
  total: null,
  ...t,
});

describe('receipt splits (Phase 5 exit criterion 1, requirements §3.5)', () => {
  // GV 2% MLK GAL 3.48 and BANANAS 1.62 (food, untaxed); ONN USB-C CHRGR 12.88; TS MENS TEE 8.98; 8% tax 1.75.
  const walmart = [
    line('Groceries', 348n, false),
    line('Groceries', 162n, false),
    line('Electronics', 1288n, true),
    line('Clothing', 898n, true),
  ];
  const walmartTotals = totals({ tax: 175n, total: 2871n });

  it('produces exactly Groceries 5.10, Electronics 13.91, Clothing 9.70 = 28.71', () => {
    const groups = groupReceipt(walmart, walmartTotals);
    expect(groups.map((g) => [g.key, g.total])).toEqual([
      ['Groceries', 510n],
      ['Electronics', 1391n],
      ['Clothing', 970n],
    ]);
    expect(groups.map((g) => g.taxableSubtotal)).toEqual([0n, 1288n, 898n]); // taxable subtotal 21.86
    expect(groups.map((g) => g.tax)).toEqual([0n, 103n, 72n]);
    expect(groups.map((g) => g.lines)).toEqual([[0, 1], [2], [3]]);
    expect(groups.reduce((s, g) => s + g.total, 0n)).toBe(2871n);
  });

  it('validates within ±2 minor units and reports the gap otherwise (RCP-05)', () => {
    expect(validateReceipt(walmart, walmartTotals)).toEqual({ computed: 2871n, gap: 0n, ok: true });
    expect(validateReceipt(walmart, { ...walmartTotals, total: 2873n }).ok).toBe(true);
    expect(validateReceipt(walmart, { ...walmartTotals, total: 2874n })).toEqual({
      computed: 2871n,
      gap: 3n,
      ok: false,
    });
    expect(validateReceipt(walmart, { ...walmartTotals, total: null })).toEqual({
      computed: 2871n,
      gap: null,
      ok: false,
    });
  });

  it('applies line discounts to their line and order discounts and fees by subtotal (RCP-04)', () => {
    const lines = [line('A', 1000n, true, 100n), line('B', 500n, false)];
    const groups = groupReceipt(lines, totals({ tax: 72n, discount: 140n, fees: 30n, total: 1362n }));
    expect(groups.map((g) => g.subtotal)).toEqual([900n, 500n]);
    expect(groups.map((g) => g.tax)).toEqual([72n, 0n]);
    expect(groups.map((g) => g.discount)).toEqual([90n, 50n]);
    expect(groups.map((g) => g.fees)).toEqual([19n, 11n]);
    expect(groups.reduce((s, g) => s + g.total, 0n)).toBe(1362n);
    expect(validateReceipt(lines, totals({ tax: 72n, discount: 140n, fees: 30n, total: 1362n })).ok).toBe(
      true,
    );
  });

  it('keeps lines for different entities or members apart (RCP-07)', () => {
    const groups = groupReceipt(
      [line('Office supplies|business|-', 1200n, true), line('Groceries|personal|-', 800n, false)],
      totals({ tax: 96n }),
    );
    expect(groups.map((g) => [g.key, g.total])).toEqual([
      ['Office supplies|business|-', 1296n],
      ['Groceries|personal|-', 800n],
    ]);
  });

  it('reverses the category of returned lines and their tax (RCP-08)', () => {
    // Bought a 20.00 shirt, returned a 10.00 cable; 8% tax nets to 0.80.
    const groups = groupReceipt(
      [line('Clothing', 2000n, true), line('Electronics', -1000n, true)],
      totals({ tax: 80n }),
    );
    expect(groups.map((g) => [g.key, g.tax, g.total])).toEqual([
      ['Clothing', 160n, 2160n],
      ['Electronics', -80n, -1080n],
    ]);
  });

  it('spreads tax by subtotal when no line is flagged taxable', () => {
    expect(
      groupReceipt([line('A', 300n, false), line('B', 100n, false)], totals({ tax: 40n })).map((g) => g.tax),
    ).toEqual([30n, 10n]);
  });
});

describe('fitting groups to the transaction amount (04 §7 step 7)', () => {
  it('puts a difference within ±2 minor units on the largest group', () => {
    expect(fitToCharged([510n, 1391n, 970n], 2872n)).toEqual({
      ok: true,
      amounts: [510n, 1392n, 970n],
      adjustment: 1n,
    });
  });

  it('puts a later restaurant tip on the dining group, or spreads it', () => {
    expect(fitToCharged([4000n, 1000n], 5900n, { tipAllowed: true, tipGroup: 0 })).toEqual({
      ok: true,
      amounts: [4900n, 1000n],
      adjustment: 900n,
    });
    expect(fitToCharged([4000n, 1000n], 5900n, { tipAllowed: true })).toEqual({
      ok: true,
      amounts: [4720n, 1180n],
      adjustment: 900n,
    });
  });

  it('sends larger gaps, and tips above 30%, to review', () => {
    expect(fitToCharged([4000n, 1000n], 5100n)).toMatchObject({ ok: false, gap: 100n, reason: 'gap' });
    expect(fitToCharged([5000n], 6600n, { tipAllowed: true })).toMatchObject({ ok: false, gap: 1600n });
    expect(fitToCharged([], 100n)).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('foreign receipts (Phase 5 exit criterion 2, CUR-03/04)', () => {
  it('stores the implied rate: €40.00 charged as $43.60 is 1.09', () => {
    expect(decimalToString(impliedRate(4360n, 2, 4000n, 2))).toBe('1.0900000000');
    expect(decimalToString(impliedRate(6543n, 2, 10000n, 0))).toBe('0.0065430000'); // ¥10,000 → $65.43
  });

  it('matches within ±3% of the day rate and converts the splits at the implied rate', () => {
    const receiptEur = [2500n, 1500n]; // €25.00 + €15.00
    const dayRate = { coefficient: 10912n, scale: 4 }; // 1 EUR = 1.0912 USD
    const expectedUsd = mulRound(4000n, dayRate, 'half_even'); // $43.65
    expect(deviationBps(4360n, expectedUsd)).toBe(-11n); // −0.11%, inside ±3%
    expect(deviationBps(4490n, expectedUsd)).toBe(286n); // +2.86%, inside
    expect(deviationBps(4500n, expectedUsd)).toBe(309n); // +3.09%, just outside
    expect(FX_MATCH_TOLERANCE_BPS).toBe(300n);
    expect(deviationBps(4600n, expectedUsd)).toBe(538n); // outside
    const usd = convertGroupsAtCharge(receiptEur, 4360n);
    expect(usd).toEqual([2725n, 1635n]);
    expect(usd.reduce((a, b) => a + b)).toBe(4360n);
  });
});

describe('properties', () => {
  const amount = fc.bigInt({ min: -100_000n, max: 100_000n });
  const lineArb = fc.record({
    key: fc.constantFrom('A', 'B', 'C', 'D'),
    lineTotal: fc.bigInt({ min: -50_000n, max: 200_000n }).filter((n) => n !== 0n),
    discount: fc.bigInt({ min: 0n, max: 1_000n }),
    taxable: fc.boolean(),
  });
  const totalsArb = fc.record({
    tax: fc.bigInt({ min: 0n, max: 20_000n }),
    discount: fc.bigInt({ min: 0n, max: 5_000n }),
    fees: fc.bigInt({ min: 0n, max: 5_000n }),
    tip: fc.bigInt({ min: 0n, max: 5_000n }),
    total: fc.constant(null),
  });

  it('group totals always sum to the computed receipt total', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 30 }), totalsArb, (lines, t) => {
        const groups = groupReceipt(lines, t);
        const sum = groups.reduce((s, g) => s + g.total, 0n);
        expect(sum).toBe(validateReceipt(lines, t).computed);
        expect(groups.reduce((s, g) => s + g.tax, 0n)).toBe(t.tax);
        expect(groups.flatMap((g) => g.lines).sort((a, b) => a - b)).toEqual(lines.map((_, i) => i));
      }),
    );
  });

  it('allocateSigned parts always sum to the total', () => {
    fc.assert(
      fc.property(amount, fc.array(amount, { minLength: 1, maxLength: 12 }), (total, weights) => {
        expect(allocateSigned(total, weights).reduce((a, b) => a + b, 0n)).toBe(total);
      }),
    );
  });

  it('converted splits always sum to the charge', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 500_000n }), { minLength: 1, maxLength: 10 }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (groups, charged) => {
          expect(convertGroupsAtCharge(groups, charged).reduce((a, b) => a + b, 0n)).toBe(charged);
        },
      ),
    );
  });
});
