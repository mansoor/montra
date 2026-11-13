/**
 * The auth gateway (AUTH-08, ADR-0042) sends a paused browser back to its form with `notice=too_many_attempts` and the
 * seconds left in `retry`. This turns those into whole minutes to show, or null when there's nothing to say.
 */
export function pausedMinutes(params: Record<string, string | undefined>): number | null {
  if (params.notice !== 'too_many_attempts') return null;
  const seconds = Number(params.retry);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(Math.min(seconds, 24 * 3600) / 60));
}
