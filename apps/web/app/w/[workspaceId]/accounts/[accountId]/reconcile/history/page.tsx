import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ReconciliationHistory } from '@/components/reconciliation-history';

export const metadata: Metadata = { title: 'Reconciliation history' };
export const dynamic = 'force-dynamic';

/** An account's reconciliations, newest statement first, with Undo on the latest (DE-13, DE-14). */
export default async function ReconciliationHistoryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; accountId: string }>;
}) {
  const { workspaceId, accountId } = await params;
  const [[accounts, history], { t, date }] = await Promise.all([
    load((api) =>
      Promise.all([api.listAccounts(workspaceId), api.reconciliationHistory(workspaceId, accountId)]),
    ),
    getI18n(),
  ]);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) notFound();
  const base = `/w/${workspaceId}/accounts/${accountId}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="page-title">{t('reconcile.history.heading', { account: account.name })}</h1>
          <p className="text-sm text-muted" data-testid="reconciled-through">
            {history.reconciledThrough
              ? t('accounts.reconciled_through', { date: date(history.reconciledThrough) })
              : t('reconcile.history.never')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`${base}/reconcile`} className="btn-primary">
            {history.inProgressId ? t('reconcile.resume') : t('reconcile.start')}
          </Link>
          <Link href={base} className="text-sm font-medium text-brand-600 underline">
            {t('reconcile.back')}
          </Link>
        </div>
      </div>
      <p className="text-sm text-muted">{t('reconcile.history.intro')}</p>
      <ReconciliationHistory workspaceId={workspaceId} history={history} />
    </div>
  );
}
