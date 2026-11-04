import type { Metadata } from 'next';
import { getPublicI18n } from '@/lib/i18n-public';
import { UnsubscribeButton } from '@/components/account-state';
import { I18nProvider } from '@/components/i18n';

export const metadata: Metadata = { title: 'Unsubscribe' };

/** OPS-10: from a link in an email, with no session. */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const { t, locale } = getPublicI18n();
  return (
    <I18nProvider locale={locale} dateFormat={null}>
      <main className="mx-auto max-w-md space-y-4 px-4 py-16">
        <h1 className="page-title">{t('unsubscribe.title')}</h1>
        <p className="text-sm text-muted">{t('unsubscribe.hint')}</p>
        {token ? <UnsubscribeButton token={token} /> : <p className="text-sm">{t('unsubscribe.no_token')}</p>}
      </main>
    </I18nProvider>
  );
}
