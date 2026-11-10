import { describe, expect, it } from 'vitest';
import { categoryStats, whatIf } from '../src/spending-explore.js';

const b = (...xs: number[]) => xs.map(BigInt);

describe('Explore spending: a category’s habits (FLOW-01)', () => {
  // Seven months: six full, then the current one (left out of averages).
  const dining = b(10000, 12000, 11000, 15000, 16000, 14000, 3000);
  const counts = [5, 6, 5, 8, 8, 7, 1];
  const all = b(100000, 100000, 100000, 100000, 100000, 100000, 20000);

  it('averages full months, compares the last three with the three before, and finds the biggest month', () => {
    const s = categoryStats(dining, counts, all);
    expect(s.total).toBe(81000n);
    expect(s.average).toBe(13000n);
    expect(s.highest).toEqual({ index: 4, amount: 16000n });
    expect(s.recent).toBe(15000n);
    expect(s.earlier).toBe(11000n);
    expect(s.changePercent).toBe(36);
    expect(s.share).toBe(13);
    expect(s.purchasesPerMonth).toBe(6.5);
    expect(s.typical).toBe(2025n); // 81000 over 40 purchases
  });

  it('has nothing to compare with a short history, and no typical purchase without purchases', () => {
    const s = categoryStats(b(5000, 7000, 100), [2, 3, 0], b(50000, 50000, 1000));
    expect(s.earlier).toBeNull();
    expect(s.changePercent).toBeNull();
    expect(s.average).toBe(6000n);
    expect(categoryStats(b(0, 0), [0, 0], b(0, 0))).toMatchObject({ highest: null, typical: null, share: 0 });
  });
});

describe('Explore spending: what if (FLOW-01)', () => {
  const income = b(500000, 500000, 500000, 0);
  const spending = b(400000, 400000, 400000, 50000);
  const categories = [
    { categoryId: 'dining', monthly: b(30000, 30000, 30000, 5000) },
    { categoryId: 'fuel', monthly: b(10000, 12000, 14000, 0) },
  ];

  it('saves a share of a cut, or what a cap trims off the average, and shows the share of income kept', () => {
    const r = whatIf({
      income,
      spending,
      categories,
      changes: [
        { categoryId: 'dining', cutPercent: 20 },
        { categoryId: 'fuel', capMinor: 10000n },
      ],
    });
    expect(r.perCategory).toEqual([
      { categoryId: 'dining', monthly: 6000n },
      { categoryId: 'fuel', monthly: 2000n },
    ]);
    expect(r).toMatchObject({ monthly: 8000n, yearly: 96000n, keptBefore: 20, keptAfter: 22 });
  });

  it('saves nothing from a cap above the average, and clamps a cut to 0–100%', () => {
    const r = whatIf({
      income,
      spending,
      categories,
      changes: [
        { categoryId: 'fuel', capMinor: 50000n },
        { categoryId: 'dining', cutPercent: 150 },
      ],
    });
    expect(r.perCategory.map((x) => x.monthly)).toEqual([0n, 30000n]);
  });

  it('brings goals closer, and says never at a pace that doesn’t save', () => {
    const r = whatIf({
      income,
      spending,
      categories,
      changes: [{ categoryId: 'dining', cutPercent: 50 }],
      goals: [
        { id: 'trip', name: 'Trip', remaining: 300000n },
        { id: 'done', name: 'Done', remaining: 0n },
      ],
    });
    // Kept 100,000 a month; 115,000 with the cut.
    expect(r.goals).toEqual([
      { id: 'trip', name: 'Trip', monthsBefore: 3, monthsAfter: 3 },
      { id: 'done', name: 'Done', monthsBefore: 0, monthsAfter: 0 },
    ]);
    const tight = whatIf({
      income: b(100, 100),
      spending: b(200, 0),
      categories,
      changes: [],
      goals: [{ id: 'x', name: 'X', remaining: 1000n }],
    });
    expect(tight.goals[0]).toMatchObject({ monthsBefore: null, monthsAfter: null });
    expect(tight.keptBefore).toBe(-100);
  });
});
