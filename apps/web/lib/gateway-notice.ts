/**
 * The auth gateway (ADR-0042, ADR-0043) sends a browser back to its form with a `notice`:
 * - `too_many_attempts` with the seconds left in `retry`;
 * - `weak_password` with `problems` (`too_short`, `too_weak`) and the minimum length in `min`.
 * This reads them into something to show, or null when there's nothing to say.
 */
export type GatewayNoticeInfo =
  | { kind: 'paused'; minutes: number }
  | { kind: 'weak_password'; tooShort: boolean; tooWeak: boolean; minLength: number };

export function pausedMinutes(params: Record<string, string | undefined>): number | null {
  if (params.notice !== 'too_many_attempts') return null;
  const seconds = Number(params.retry);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(Math.min(seconds, 24 * 3600) / 60));
}

export function gatewayNotice(params: Record<string, string | undefined>): GatewayNoticeInfo | null {
  const minutes = pausedMinutes(params);
  if (minutes !== null) return { kind: 'paused', minutes };
  if (params.notice !== 'weak_password') return null;
  const problems = new Set((params.problems ?? '').split(','));
  const min = Number(params.min);
  const tooShort = problems.has('too_short');
  return {
    kind: 'weak_password',
    tooShort,
    // An odd or empty list still says something useful.
    tooWeak: problems.has('too_weak') || !tooShort,
    minLength: Number.isInteger(min) && min >= 12 && min <= 64 ? min : 12,
  };
}
