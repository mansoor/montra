/**
 * The auth gateway (ADR-0042, ADR-0043) sends a browser back to its form with a `notice`:
 * - `too_many_attempts` with the seconds left in `retry`;
 * - `weak_password` with `problems` (`too_short`, `too_weak`) and the minimum length in `min`;
 * - `phone_in_app`: a mobile number is changed in its own section, not the profile form (ADR-0049 §6);
 * - `captcha_required`: the next sign-in or sign-up needs a CAPTCHA (ADR-0056).
 * This reads them into something to show, or null when there's nothing to say.
 */
export type GatewayNoticeInfo =
  | { kind: 'paused'; minutes: number }
  | { kind: 'weak_password'; tooShort: boolean; tooWeak: boolean; minLength: number }
  | { kind: 'phone_in_app' }
  | { kind: 'captcha'; siteKey: string | null };

/**
 * The Turnstile site key (ADR-0056), compiled in at build time like NEXT_PUBLIC_KRATOS_URL. Unset, this install can't
 * show the widget; the auth gateway only asks for one when it has the matching secret.
 */
export const TURNSTILE_SITE_KEY: string | null = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || null;

/** The site key to show the CAPTCHA widget with: only when the gateway asked for one and the build has a key. */
export function captchaSiteKey(
  params: Record<string, string | undefined>,
  siteKey: string | null = TURNSTILE_SITE_KEY,
): string | null {
  return params.notice === 'captcha_required' && siteKey ? siteKey : null;
}

export function pausedMinutes(params: Record<string, string | undefined>): number | null {
  if (params.notice !== 'too_many_attempts') return null;
  const seconds = Number(params.retry);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(Math.min(seconds, 24 * 3600) / 60));
}

export function gatewayNotice(
  params: Record<string, string | undefined>,
  siteKey: string | null = TURNSTILE_SITE_KEY,
): GatewayNoticeInfo | null {
  const minutes = pausedMinutes(params);
  if (minutes !== null) return { kind: 'paused', minutes };
  if (params.notice === 'captcha_required')
    return { kind: 'captcha', siteKey: captchaSiteKey(params, siteKey) };
  if (params.notice === 'phone_in_app') return { kind: 'phone_in_app' };
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
