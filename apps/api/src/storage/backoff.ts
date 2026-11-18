/**
 * The retry pacing the mirror's job and the vault's share (ADR-0031 §5, ADR-0054 §12). On its own, so the vault's code
 * can use it without importing the mirror's job, which reads files through `FileBytes`, which uses the vault's service.
 */

/** Minutes to wait after each failed attempt; the last repeats. A row gives up after MAX_ATTEMPTS. */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720, 1440];
export const MAX_ATTEMPTS = 10;

export const backoffMs = (attempts: number) =>
  BACKOFF_MIN[Math.min(Math.max(attempts, 1), BACKOFF_MIN.length) - 1]! * 60_000;
