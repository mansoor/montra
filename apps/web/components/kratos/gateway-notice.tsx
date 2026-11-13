import { pausedMinutes } from '@/lib/gateway-notice';
import { staticT as t } from '@/lib/i18n-static';

/** Shown above a sign-in form the auth gateway paused (AUTH-08, ADR-0042). */
export function GatewayNotice({ params }: { params: Record<string, string | undefined> }) {
  const minutes = pausedMinutes(params);
  if (minutes === null) return null;
  return (
    <p role="alert" className="rounded-md bg-bad/10 px-3 py-2 text-sm text-bad" data-testid="gateway-notice">
      {t('auth.too_many_attempts', { minutes })}
    </p>
  );
}
