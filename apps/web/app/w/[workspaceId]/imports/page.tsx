import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { BATCH_TONE, canUndo } from '@/lib/imports';
import { UndoButton } from '@/components/imports/undo-button';

export const metadata: Metadata = { title: 'Imports' };
export const dynamic = 'force-dynamic';

/** Import history (IMP-09): every batch with its outcome, and undo while it is allowed. */
export default async function ImportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ account?: string }>;
}) {
  const { workspaceId } = await params;
  const accountId = (await searchParams).account;
  const [[batches, accounts], { t, date, locale }] = await Promise.all([
    load((api) => Promise.all([api.listImports(workspaceId, accountId), api.listAccounts(workspaceId)])),
    getI18n(),
  ]);
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const uploaded = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const base = `/w/${workspaceId}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('imports.history.title')}</h1>
        <Link href={`${base}/import${accountId ? `?account=${accountId}` : ''}`} className="btn-primary">
          {t('imports.upload.title')}
        </Link>
      </div>
      {batches.length === 0 ? (
        <p className="card text-sm text-muted">{t('imports.history.empty')}</p>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">{t('imports.history.title')}</caption>
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-2">
                  {t('imports.history.file')}
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('fields.account')}
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('imports.history.uploaded')}
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('imports.history.status')}
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  {t('imports.summary.added')}
                </th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">{t('imports.history.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {batches.map((b) => (
                <tr key={b.id} data-testid="import-history-row">
                  <td className="px-4 py-2">
                    <Link className="font-medium underline" href={`${base}/imports/${b.id}`}>
                      {b.fileName}
                    </Link>
                    {b.minDate && b.maxDate && (
                      <span className="block text-xs text-muted">
                        {t('imports.date_range', { from: date(b.minDate), to: date(b.maxDate) })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{names.get(b.accountId) ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2">{uploaded.format(new Date(b.createdAt))}</td>
                  <td className="px-4 py-2">
                    <span className={`chip chip-${BATCH_TONE[b.status]}`}>
                      {t(`imports.status.${b.status}`)}
                    </span>
                  </td>
                  <td className="num px-4 py-2 text-right">{b.counts.added}</td>
                  <td className="px-4 py-2 text-right">
                    {canUndo(b) && <UndoButton workspaceId={workspaceId} batchId={b.id} navigate />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
