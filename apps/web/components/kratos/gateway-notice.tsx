import { gatewayNotice } from '@/lib/gateway-notice';
import { staticT as t } from '@/lib/i18n-static';

/** Shown above a form the auth gateway sent back: paused (ADR-0042) or a weak new password (ADR-0043). */
export function GatewayNotice({ params }: { params: Record<string, string | undefined> }) {
  const notice = gatewayNotice(params);
  if (!notice) return null;
  const text =
    notice.kind === 'paused'
      ? t('auth.too_many_attempts', { minutes: notice.minutes })
      : [
          notice.tooShort ? t('auth.password_too_short', { min: notice.minLength }) : null,
          notice.tooWeak ? t('auth.password_too_weak') : null,
        ]
          .filter(Boolean)
          .join(' ');
  return (
    <p role="alert" className="rounded-md bg-bad/10 px-3 py-2 text-sm text-bad" data-testid="gateway-notice">
      {text}
    </p>
  );
}
