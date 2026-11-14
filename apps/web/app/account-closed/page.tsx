import type { Metadata } from 'next';
import Link from 'next/link';
import { getPublicI18n } from '@/lib/i18n-public';
import { PublicShell } from '@/components/public-shell';

export const metadata: Metadata = { title: 'Closed for now' };

/**
 * ADR-0049 §4: where a suspended person, or a member of a workspace whose owner is suspended, lands. Public, since a
 * suspended person can't load their profile. Nothing is deleted; support can say more.
 */
export default async function AccountClosedPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const { t } = getPublicI18n();
  const workspace = (await searchParams).workspace === '1';
  return (
    <PublicShell>
      <section className="mx-auto max-w-md space-y-4 py-12">
        <h1 className="page-title">{t(workspace ? 'closed.workspace_title' : 'closed.account_title')}</h1>
        <p className="text-sm">{t(workspace ? 'closed.workspace_body' : 'closed.account_body')}</p>
        <p className="text-sm text-muted">{t('closed.kept')}</p>
        <Link className="underline" href="/help">
          {t('closed.help')}
        </Link>
      </section>
    </PublicShell>
  );
}
