import { gatewayNotice } from '@/lib/gateway-notice';
import { staticT as t } from '@/lib/i18n-static';

/**
 * Shown above a form the auth gateway sent back: paused (ADR-0042), a weak new password (ADR-0043), or a number to
 * change in its own section (ADR-0049 §6).
 */
export function GatewayNotice({ params }: { params: Record<string, string | undefined> }) {
  const notice = gatewayNotice(params);
  if (!notice) return null;
  const text =
    notice.kind === 'paused'
      ? t('auth.too_many_attempts', { minutes: notice.minutes })
      : notice.kind === 'phone_in_app'
        ? t('auth.phone_in_app')
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
