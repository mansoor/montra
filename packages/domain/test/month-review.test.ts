import { describe, expect, it } from 'vitest';
import { biggestChanges, budgetSuggestions, keptPercent, usualOf } from '../src/month-review.js';

describe('Month in review: changes from usual (FLOW-01)', () => {
  it('averages the months before, and has no usual without any', () => {
    expect(usualOf([30000n, 33000n, 36000n])).toBe(33000n);
    expect(usualOf([])).toBeNull();
  });

  it('keeps clear changes both ways, biggest first, and drops small or new ones', () => {
    const r = biggestChanges(
      [
        { categoryId: 'dining', spent: 30000n, before: [15000n, 15000n, 15000n] }, // +150
        { categoryId: 'fuel', spent: 4000n, before: [10000n, 10000n, 10000n] }, // −60
        { categoryId: 'travel', spent: 90000n, before: [10000n, 10000n, 10000n] }, // +800
        { categoryId: 'groceries', spent: 52000n, before: [50000n, 50000n, 50000n] }, // +20: under a fifth
        { categoryId: 'coffee', spent: 1500n, before: [500n, 500n, 500n] }, // +10: under the minimum
        { categoryId: 'new', spent: 9000n, before: [] }, // no usual
      ],
      { min: 2000n },
    );
    expect(r.up.map((c) => [c.categoryId, c.change])).toEqual([
      ['travel', 80000n],
      ['dining', 15000n],
    ]);
    expect(r.down.map((c) => [c.categoryId, c.usual, c.change])).toEqual([['fuel', 10000n, -6000n]]);
  });
});

describe('Month in review: next month’s budget (BUD-02)', () => {
  it('suggests the median where it differs from what’s set by a tenth or more', () => {
    const s = budgetSuggestions(
      [
        { categoryId: 'groceries', history: [50000n, 54000n, 52000n], current: 40000n }, // 520 vs 400
        { categoryId: 'dining', history: [15000n, 16000n, 15500n], current: 15000n }, // 155 vs 150: close enough
        { categoryId: 'fun', history: [8000n, 0n, 12000n], current: null }, // none set: 80
        { categoryId: 'gone', history: [0n, 0n, 0n], current: 20000n }, // nothing spent: no suggestion
      ],
      { min: 1000n },
    );
    expect(s).toEqual([
      { categoryId: 'groceries', current: 40000n, suggested: 52000n },
      { categoryId: 'fun', current: null, suggested: 8000n },
    ]);
  });

  it('keeps the share of income kept in whole percent', () => {
    expect(keptPercent(500000n, 380000n)).toBe(24);
    expect(keptPercent(0n, 1000n)).toBeNull();
  });
});
