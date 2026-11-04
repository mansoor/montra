import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getI18n } from '@/lib/i18n-server';
import { I18nProvider } from '@/components/i18n';

export const metadata: Metadata = {
  title: { default: 'Console', template: '%s · Console' },
  robots: 'noindex',
};
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { locale, me } = await getI18n();
  return (
    <I18nProvider locale={locale} dateFormat={me.dateFormat}>
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">{children}</div>
    </I18nProvider>
  );
}
