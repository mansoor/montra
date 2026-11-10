import { describe, expect, it } from 'vitest';
import { labelIndexes, linePoints, valueRange } from '../src/features/chart-geometry';

const box = { width: 110, height: 60, left: 10, right: 0, top: 0, bottom: 10 };

describe('phone chart geometry (FLOW-01)', () => {
  it('draws flows from zero and a balance around its values', () => {
    expect(valueRange([200, 500], true)).toEqual({ min: 0, max: 500 });
    expect(valueRange([-100, 300], true)).toEqual({ min: -100, max: 300 });
    expect(valueRange([200, 500], false)).toEqual({ min: 200, max: 500 });
    expect(valueRange([7, 7], false)).toEqual({ min: 6, max: 8 });
    expect(valueRange([], true)).toEqual({ min: 0, max: 1 });
  });

  it('spreads points across the plot, highest at the top', () => {
    expect(linePoints([0, 50, 100], box, { min: 0, max: 100 })).toEqual([
      { x: 10, y: 50 },
      { x: 60, y: 25 },
      { x: 110, y: 0 },
    ]);
    expect(linePoints([5], box, { min: 0, max: 10 })).toEqual([{ x: 60, y: 25 }]);
  });

  it('labels the first and last month and a few between', () => {
    expect(labelIndexes(3, 4)).toEqual([0, 1, 2]);
    expect(labelIndexes(6, 4)).toEqual([0, 2, 5]);
    expect(labelIndexes(12, 4)).toEqual([0, 3, 6, 11]);
    expect(labelIndexes(24, 4)).toEqual([0, 6, 12, 23]);
    expect(labelIndexes(0, 4)).toEqual([]);
  });
});
