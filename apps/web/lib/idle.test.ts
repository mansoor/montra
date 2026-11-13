import { describe, expect, it } from 'vitest';
import { idleState } from './idle';

describe('idle sign-out (AUTH-07)', () => {
  const t0 = 1_000_000;
  it('warns for the last minute, then signs out', () => {
    expect(idleState(t0, t0 + 13 * 60_000, 15)).toEqual({ kind: 'active' });
    expect(idleState(t0, t0 + 14 * 60_000, 15)).toEqual({ kind: 'warning', secondsLeft: 60 });
    expect(idleState(t0, t0 + 14 * 60_000 + 59_500, 15)).toEqual({ kind: 'warning', secondsLeft: 1 });
    expect(idleState(t0, t0 + 15 * 60_000, 15)).toEqual({ kind: 'expired' });
  });

  it('treats a clock that went backwards as just used', () => {
    expect(idleState(t0, t0 - 5000, 5)).toEqual({ kind: 'active' });
  });
});
