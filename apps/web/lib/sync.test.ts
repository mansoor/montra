import { describe, expect, it } from 'vitest';
import { ACTION_SETTLE_MS, refreshWaitAfterAction } from './sync';

describe('refreshWaitAfterAction', () => {
  it('holds a background refresh until a click has had time to navigate', () => {
    expect(refreshWaitAfterAction(10_000, 10_100)).toBe(ACTION_SETTLE_MS - 100);
    expect(refreshWaitAfterAction(10_000, 10_000 + ACTION_SETTLE_MS)).toBe(0);
    expect(refreshWaitAfterAction(10_000, 99_000)).toBe(0);
  });

  it('goes straight away when the user has done nothing', () => {
    expect(refreshWaitAfterAction(0, 1_000_000)).toBe(0);
  });
});
