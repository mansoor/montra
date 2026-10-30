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
  const [[workspace, accounts, reconciliation], { t }] = await Promise.all([
    load((api) =>
      Promise.all([
        api.getWorkspace(workspaceId),
        api.listAccounts(workspaceId),
        reconciliationId ? api.getReconciliation(workspaceId, reconciliationId) : Promise.resolve(null),
      ]),
    ),
    getI18n(),
  ]);
  const account = accounts.find((a) => a.id === accountId);
  if (!account || (reconciliation && reconciliation.accountId !== accountId)) notFound();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('reconcile.title', { account: account.name })}</h1>
        <Link
          href={`/w/${workspaceId}/accounts/${accountId}`}
          className="text-sm font-medium text-brand-600 underline"
        >
          {t('reconcile.back')}
        </Link>
      </div>
      <Reconciler
        workspaceId={workspaceId}
        account={account}
        initial={reconciliation}
        today={todayIn(workspace.timeZone)}
      />
    </div>
  );
}
