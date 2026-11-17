import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ImportHistory } from '@/components/imports/import-history';

export const metadata: Metadata = { title: 'Imports' };
export const dynamic = 'force-dynamic';

/**
 * Import history (IMP-09): every batch with its outcome, and undo while it is allowed. The Statements screen shows the
 * same list (ADR-0051); this page stays for one account's history, linked from its page.
 */
export default async function ImportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ account?: string }>;
}) {
  const { workspaceId } = await params;
  const accountId = (await searchParams).account;
  const [[batches, accounts], { t }] = await Promise.all([
    load((api) => Promise.all([api.listImports(workspaceId, accountId), api.listAccounts(workspaceId)])),
    getI18n(),
  ]);
  const base = `/w/${workspaceId}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">{t('imports.history.title')}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`${base}/statements`} className="text-sm font-medium text-brand-600 underline">
            {t('nav.statements')}
          </Link>
          <Link href={`${base}/import${accountId ? `?account=${accountId}` : ''}`} className="btn-primary">
            {t('imports.upload.title')}
          </Link>
        </div>
      </div>
      <ImportHistory
        workspaceId={workspaceId}
        batches={batches}
        accounts={accounts}
        title={t('imports.history.title')}
      />
    </div>
  );
}
