import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { CancelDeletion } from '@/components/account-state';
import { I18nProvider } from '@/components/i18n';

export const metadata: Metadata = { title: 'Account being deleted' };
export const dynamic = 'force-dynamic';

/** Where an account being deleted lands (BAK-09): when it goes, and the way back. */
export default async function AccountDeletingPage() {
  const status = await load((api) => api.getDeletionStatus());
  const { t, locale } = await getI18n();
  const when = status.purgeAfter
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(status.purgeAfter))
    : null;
  return (
    <I18nProvider locale={locale} dateFormat={null}>
      <main className="mx-auto max-w-md space-y-4 px-4 py-16">
        <h1 className="page-title">{t('account_deleting.title')}</h1>
        <p className="text-sm">
          {when ? t('account_deleting.when', { date: when }) : t('account_deleting.not_requested')}
        </p>
        <p className="text-sm text-muted">{t('account_deleting.hint')}</p>
        <CancelDeletion />
      </main>
    </I18nProvider>
  );
}
