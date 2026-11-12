import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { Reconciler } from '@/components/reconciler';

export const metadata: Metadata = { title: 'Reconcile' };
export const dynamic = 'force-dynamic';

export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; accountId: string }>;
  searchParams: Promise<{ r?: string }>;
}) {
  const { workspaceId, accountId } = await params;
  const reconciliationId = (await searchParams).r;
  const [[workspace, accounts, history, categories, reconciliation], { t }] = await Promise.all([
    load((api) =>
      Promise.all([
        api.getWorkspace(workspaceId),
        api.listAccounts(workspaceId),
        api.reconciliationHistory(workspaceId, accountId),
        api.listCategories(workspaceId),
        // Without ?r=, resume the account's unfinished reconciliation, if any.
        reconciliationId
          ? api.getReconciliation(workspaceId, reconciliationId)
          : api.listReconciliations(workspaceId, accountId, 'in_progress').then((list) => list[0] ?? null),
      ]),
    ),
    getI18n(),
  ]);
  const account = accounts.find((a) => a.id === accountId);
  if (!account || (reconciliation && reconciliation.accountId !== accountId)) notFound();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">{t('reconcile.title', { account: account.name })}</h1>
        <div className="flex flex-wrap gap-3">
          <Link
            href={`/w/${workspaceId}/accounts/${accountId}/reconcile/history`}
            className="text-sm font-medium text-brand-600 underline"
          >
            {t('reconcile.history_link')}
          </Link>
          <Link
            href={`/w/${workspaceId}/accounts/${accountId}`}
            className="text-sm font-medium text-brand-600 underline"
          >
            {t('reconcile.back')}
          </Link>
        </div>
      </div>
      <Reconciler
        workspaceId={workspaceId}
        account={account}
        initial={reconciliation}
        today={todayIn(workspace.timeZone)}
        next={{
          statementDate: history.next.statementDate,
          openingBalance: history.next.openingBalance.amount,
        }}
        categories={categories.filter((c) => c.entityId === account.entityId)}
      />
    </div>
  );
}
