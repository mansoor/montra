import type { Metadata } from 'next';
import Link from 'next/link';
import { getI18n } from '@/lib/i18n-server';
import { vaultOpenHref, vaultOpenProblemKey } from '@/lib/vault';

export const metadata: Metadata = { title: 'Family Document Vault' };
export const dynamic = 'force-dynamic';

/**
 * ADR-0054 §9: why a document didn't open in the household's Family Document Vault, in words. Reached only from
 * "Open in the vault" when the vault or Montra said no; it holds no link, only the reason and how long to wait.
 */
export default async function VaultOpenProblemPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; fileId: string }>;
  searchParams: Promise<{ problem?: string; minutes?: string }>;
}) {
  const { workspaceId, fileId } = await params;
  const sp = await searchParams;
  const { t } = await getI18n();
  const minutes = Math.max(1, Math.min(60, Number.parseInt(sp.minutes ?? '', 10) || 1));
  const again = sp.problem === 'links_full' || sp.problem === 'failed';
  // §5: a file only the vault holds isn't shown from Montra; the person opens it there.
  const inVault = sp.problem === 'in_vault';
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6" data-testid="vault-open-problem">
      <h1 className="text-lg font-semibold">{t('vault.open_title')}</h1>
      <p className="text-sm">{t(vaultOpenProblemKey(sp.problem), { minutes })}</p>
      <div className="flex flex-wrap gap-3 text-sm">
        {inVault && (
          // A plain link: the single-use link is made only on this click, and nothing prefetches it.
          <a
            className="btn-primary"
            href={vaultOpenHref(workspaceId, fileId)}
            data-testid="vault-open-from-problem"
          >
            {t('vault.open_in_vault')}
          </a>
        )}
        {again && (
          // A plain link: a new click makes a new link, and nothing prefetches it.
          <a className="btn-secondary" href={vaultOpenHref(workspaceId, fileId)}>
            {t('vault.open_again')}
          </a>
        )}
        <Link className="underline" href={`/w/${workspaceId}`}>
          {t('vault.open_back')}
        </Link>
      </div>
    </main>
  );
}
