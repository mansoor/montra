import type { Metadata } from 'next';
import Link from 'next/link';
import { isCalendarDate } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { Money } from '@/components/money';

export const metadata: Metadata = { title: 'Journal' };
export const dynamic = 'force-dynamic';

const KINDS = [
  'standard',
  'transfer',
  'opening_balance',
  'adjustment',
  'reversal',
  'depreciation',
  'fx_revaluation',
  'closing',
  'manual',
] as const;

/** Journal list (DE-07): every entry with its total, filterable by books, kind and dates (a GET form). */
export default async function JournalListPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const filters = {
    entityId: q.entityId || undefined,
    kind: q.kind && (KINDS as readonly string[]).includes(q.kind) ? q.kind : undefined,
    from: q.from && isCalendarDate(q.from) ? q.from : undefined,
    to: q.to && isCalendarDate(q.to) ? q.to : undefined,
    limit: 200,
  };
  const [[workspace, entries], { t, date }] = await Promise.all([
    load((api) => Promise.all([api.getWorkspace(workspaceId), api.listJournalEntries(workspaceId, filters)])),
    getI18n(),
  ]);
  const entityName = new Map(workspace.entities.map((e) => [e.id, e]));
  const base = `/w/${workspaceId}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('journal.title')}</h1>
        <Link href={`${base}/journal/new`} className="btn-primary">
          {t('journal.new')}
        </Link>
      </div>
      <form method="get" className="card flex flex-wrap items-end gap-3" aria-label={t('journal.filters')}>
        <div>
          <label htmlFor="jf-entity" className="field-label">
            {t('bulk.books')}
          </label>
          <select id="jf-entity" name="entityId" className="input" defaultValue={filters.entityId ?? ''}>
            <option value="">{t('journal.all_books')}</option>
            {workspace.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="jf-kind" className="field-label">
            {t('journal.kind_label')}
          </label>
          <select id="jf-kind" name="kind" className="input" defaultValue={filters.kind ?? ''}>
            <option value="">{t('journal.all_kinds')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`journal.kind.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="jf-from" className="field-label">
            {t('journal.from')}
          </label>
          <input id="jf-from" name="from" type="date" className="input" defaultValue={filters.from ?? ''} />
        </div>
        <div>
          <label htmlFor="jf-to" className="field-label">
            {t('journal.to')}
          </label>
          <input id="jf-to" name="to" type="date" className="input" defaultValue={filters.to ?? ''} />
        </div>
        <button type="submit" className="btn-secondary">
          {t('journal.apply_filters')}
        </button>
      </form>
      {entries.length === 0 ? (
        <p className="card text-sm text-muted">{t('journal.empty')}</p>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">{t('journal.title')}</caption>
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-2">
                  {t('fields.date')}
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('fields.description')}
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('bulk.books')}
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('journal.kind_label')}
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  {t('journal.total')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {entries.map((e) => {
                const entity = entityName.get(e.entityId);
                return (
                  <tr key={e.id} data-testid="journal-row">
                    <td className="whitespace-nowrap px-4 py-2">
                      <time dateTime={e.date}>{date(e.date)}</time>
                    </td>
                    <td className="px-4 py-2">
                      {e.transactionId ? (
                        <Link href={`${base}/transactions/${e.transactionId}`} className="hover:underline">
                          {e.description || t('editor.untitled')}
                        </Link>
                      ) : (
                        e.description || t('editor.untitled')
                      )}
                      {e.locked && <span className="ml-2 text-xs text-muted">{t('journal.locked')}</span>}
                    </td>
                    <td className="px-4 py-2">{entity?.name ?? ''}</td>
                    <td className="px-4 py-2">{t(`journal.kind.${e.kind}`)}</td>
                    <td className="px-4 py-2 text-right">
                      <Money
                        amount={e.total}
                        currency={entity?.functionalCurrency ?? workspace.baseCurrency}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
