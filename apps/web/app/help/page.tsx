import type { Metadata } from 'next';
import { getPublicI18n } from '@/lib/i18n-public';
import { HelpSearch } from '@/components/help';
import { PublicShell } from '@/components/public-shell';

export const metadata: Metadata = { title: 'Help' };

export default function PublicHelpPage() {
  const { t } = getPublicI18n();
  return (
    <PublicShell>
      <h1 className="page-title">{t('help.title')}</h1>
      <HelpSearch />
    </PublicShell>
  );
}
