import Link from 'next/link';
import type { AccountDto, ImportBatchDto } from '@montra/api-client';
import { getI18n } from '@/lib/i18n-server';
import { BATCH_TONE, canUndo } from '@/lib/imports';
import { UndoButton } from './undo-button';

/**
 * Import history (IMP-09): every batch with its outcome, and undo while it's allowed. Shown on the Statements screen
 * and on `/imports` (one account's, from its page), so there's one list.
 */
export async function ImportHistory({
  workspaceId,
  batches,
  accounts,
  title,
}: {
  workspaceId: string;
  batches: ImportBatchDto[];
  accounts: AccountDto[];
  /** The table's caption; also its heading when given. */
  title: string;
}) {
  const { t, date, locale } = await getI18n();
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const uploaded = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const base = `/w/${workspaceId}`;
  if (batches.length === 0) return <p className="card text-sm text-muted">{t('imports.history.empty')}</p>;
  return (
    <div className="card overflow-x-auto p-0">
      <table className="tbl min-w-[40rem] text-sm">
        <caption className="sr-only">{title}</caption>
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
                <span className={`chip chip-${BATCH_TONE[b.status]}`}>{t(`imports.status.${b.status}`)}</span>
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
  );
}
