/**
 * The web's idle sign-out (AUTH-07, ADR-0044): after the workspace's idle timeout without use the browser signs out,
 * with a warning for the last minute. Every tab shares one "last used" time, so working in one keeps the others open.
 */
export const WARNING_MS = 60_000;
export const LAST_ACTIVE_KEY = 'montra.lastActive';

export type IdleState = { kind: 'active' } | { kind: 'warning'; secondsLeft: number } | { kind: 'expired' };

export function idleState(lastActive: number, now: number, minutes: number): IdleState {
  const limit = minutes * 60_000;
  const idle = Math.max(0, now - lastActive);
  if (idle >= limit) return { kind: 'expired' };
  if (idle >= limit - WARNING_MS) return { kind: 'warning', secondsLeft: Math.ceil((limit - idle) / 1000) };
  return { kind: 'active' };
}

/** The latest "last used" time across tabs; storage may be unavailable, which leaves this tab's own. */
export function sharedLastActive(own: number): number {
  try {
    const stored = Number(window.localStorage.getItem(LAST_ACTIVE_KEY));
    return Number.isFinite(stored) && stored > own ? stored : own;
  } catch {
    return own;
  }
}

export function recordActive(at: number): void {
  try {
    window.localStorage.setItem(LAST_ACTIVE_KEY, String(at));
  } catch {
    // Private windows and blocked storage: this tab still counts its own use.
  }
}
