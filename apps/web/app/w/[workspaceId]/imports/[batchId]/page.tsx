import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ImportWizard } from '@/components/imports/import-wizard';

export const metadata: Metadata = { title: 'Import' };
export const dynamic = 'force-dynamic';

export default async function ImportBatchPage({
  params,
}: {
  params: Promise<{ workspaceId: string; batchId: string }>;
}) {
  const { workspaceId, batchId } = await params;
  const [[batch, accounts], { t }] = await Promise.all([
    load((api) => Promise.all([api.getImport(workspaceId, batchId), api.listAccounts(workspaceId)])),
    getI18n(),
  ]);
  const account = accounts.find((a) => a.id === batch.accountId);
  const categories = await load((api) => api.listCategories(workspaceId, account?.entityId));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{batch.fileName}</h1>
          {account && (
            <p className="text-sm text-muted">
              {t('imports.into_account')}{' '}
              <Link className="underline" href={`/w/${workspaceId}/accounts/${account.id}`}>
                {account.name}
              </Link>
            </p>
          )}
        </div>
        <Link href={`/w/${workspaceId}/imports`} className="text-sm font-medium text-brand-600 underline">
          {t('imports.history.title')}
        </Link>
      </div>
      <ImportWizard workspaceId={workspaceId} initial={batch} categories={categories} />
    </div>
  );
}
