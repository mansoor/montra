import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { UploadForm } from '@/components/imports/upload-form';

export const metadata: Metadata = { title: 'Import statement' };
export const dynamic = 'force-dynamic';

export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ account?: string }>;
}) {
  const { workspaceId } = await params;
  const wanted = (await searchParams).account;
  const [accounts, { t }] = await Promise.all([load((api) => api.listAccounts(workspaceId)), getI18n()]);
  const open = accounts.filter((a) => !a.archived);
  const base = `/w/${workspaceId}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('imports.upload.title')}</h1>
        <Link href={`${base}/imports`} className="text-sm font-medium text-brand-600 underline">
          {t('imports.history.title')}
        </Link>
      </div>
      <p className="text-sm text-muted">{t('imports.upload.intro')}</p>
      {open.length === 0 ? (
        <p className="card text-sm text-muted">
          {t('imports.upload.no_accounts')}{' '}
          <Link className="underline" href={`${base}/accounts/new`}>
            {t('nav.add_account')}
          </Link>
        </p>
      ) : (
        <UploadForm
          workspaceId={workspaceId}
          accounts={open}
          defaultAccountId={open.find((a) => a.id === wanted)?.id ?? open[0]!.id}
        />
      )}
    </div>
  );
}
