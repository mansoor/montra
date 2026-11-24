import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReceiptListOptions } from '@montra/api-client';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { STATUS_CHIP, stalledReasons } from '@/lib/receipts';
import { isAdminRole } from '@/lib/settings';
import { receiptsInTrash } from '@/lib/trash';
import { TrashList } from '@/components/trash-list';
import { ReceiptUpload } from '@/components/receipts/receipt-upload';
import { ReceiptRecommendations } from '@/components/receipts/recommendations';
import { OrderImport } from '@/components/receipts/order-import';
import { ReceiptAmount, ReceiptDate } from '@/components/receipts/receipt-cells';

export const metadata: Metadata = { title: 'Receipts' };
export const dynamic = 'force-dynamic';

const TABS = {
  inbox: { label: 'receipts.tab.inbox', query: { status: 'inbox' } },
  review: { label: 'receipts.tab.review', query: { status: 'needs_review' } },
  matched: { label: 'receipts.tab.matched', query: { status: 'matched' } },
  all: { label: 'receipts.tab.all', query: {} },
} satisfies Record<string, { label: string; query: ReceiptListOptions }>;
type TabKey = keyof typeof TABS;

/** The receipt inbox (IMP-11), search (RCP-10), upload and receipt-recommended items (RCP-11). */
export default async function ReceiptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const tab: TabKey = sp.tab && sp.tab in TABS ? (sp.tab as TabKey) : sp.q ? 'all' : 'inbox';
  // Deleted receipts: restore, or delete a personal one for good (BAK-06, RCP-10).
  const inTrash = sp.tab === 'trash';
  const q = sp.q?.trim() || undefined;
  const [page, recommended, reading, trash] = await load((api) =>
    Promise.all([
      api.listReceipts(workspaceId, { ...TABS[tab].query, ...(q ? { q } : {}), limit: 100 }),
      api.listReceiptRecommendations(workspaceId),
      // Receipts still being read aren't in any tab but All, so they're listed above the tabs.
      api.listReceipts(workspaceId, { status: 'processing', limit: 100 }),
      inTrash
        ? Promise.all([api.listTrash(workspaceId), api.getWorkspace(workspaceId)])
        : Promise.resolve(null),
    ]),
  );
  const { t } = await getI18n();
  const base = `/w/${workspaceId}/receipts`;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">{t('receipts.title')}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`${base}/items`}
            className="text-sm font-medium text-brand-600 underline"
            data-testid="search-items"
          >
            {t('receipts.items.title')}
          </Link>
          <Link href={`/w/${workspaceId}/trips`} className="text-sm font-medium text-brand-600 underline">
            {t('trips.title')}
          </Link>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ReceiptUpload workspaceId={workspaceId} />
        <OrderImport workspaceId={workspaceId} />
      </div>
      {reading.data.length > 0 && (
        <section className="card space-y-2" aria-labelledby="receipts-reading" data-testid="receipts-reading">
          <h2 id="receipts-reading" className="text-base font-semibold">
            {t('receipts.being_read', { count: reading.data.length })}
          </h2>
          {stalledReasons(reading.data).map((reason) => (
            <p key={reason} role="alert" className="rounded-md border border-warn px-3 py-2 text-sm">
              {t(`receipts.stalled.${reason}`)}{' '}
              <Link
                href={`/w/${workspaceId}/settings?tab=ai`}
                className="font-medium text-brand-600 underline"
              >
                {t('receipts.ai_settings')}
              </Link>
            </p>
          ))}
          <ul className="divide-y divide-line text-sm">
            {reading.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`${base}/${r.id}`} className="underline">
                  {r.merchant ?? t('receipts.unknown_merchant')}
                </Link>
                <span className={r.stalled ? 'chip chip-warn' : STATUS_CHIP.processing}>
                  {t('receipts.status.processing')}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t('receipts.being_read_hint')}</p>
        </section>
      )}
      <ReceiptRecommendations workspaceId={workspaceId} items={recommended} />
      <section className="space-y-3" aria-labelledby="receipt-list">
        <h2 id="receipt-list" className="sr-only">
          {t('receipts.list')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label={t('receipts.tabs')} className="flex gap-1">
            {(Object.keys(TABS) as TabKey[]).map((k) => (
              <Link
                key={k}
                href={`${base}?tab=${k}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                aria-current={k === tab && !inTrash ? 'page' : undefined}
                className={`rounded-md px-2 py-1 text-sm ${k === tab && !inTrash ? 'bg-brand-50 font-medium text-brand-700' : 'text-muted'}`}
              >
                {t(TABS[k].label)}
              </Link>
            ))}
            <Link
              href={`${base}?tab=trash`}
              aria-current={inTrash ? 'page' : undefined}
              className={`rounded-md px-2 py-1 text-sm ${inTrash ? 'bg-brand-50 font-medium text-brand-700' : 'text-muted'}`}
              data-testid="receipts-trash-tab"
            >
              {t('receipts.tab.trash')}
            </Link>
          </nav>
          <form action={base} className="ml-auto flex gap-2" role="search">
            <input
              className="input"
              type="search"
              name="q"
              defaultValue={q}
              placeholder={t('receipts.search')}
              aria-label={t('receipts.search')}
            />
            <button type="submit" className="btn-secondary">
              {t('receipts.search_go')}
            </button>
          </form>
        </div>
        {trash ? (
          <TrashList
            workspaceId={workspaceId}
            items={receiptsInTrash(trash[0])}
            canDelete={isAdminRole(trash[1].role)}
            showDate
            showEmpty={false}
          />
        ) : page.data.length === 0 ? (
          <p className="text-sm text-muted">{t('receipts.empty')}</p>
        ) : (
          <table className="tbl text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1">{t('receipts.date')}</th>
                <th className="py-1">{t('receipts.merchant')}</th>
                <th className="py-1 text-right">{t('receipts.total')}</th>
                <th className="py-1">{t('receipts.status_col')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {page.data.map((r) => (
                <tr key={r.id} data-testid="receipt-row">
                  <td className="py-2">
                    <ReceiptDate receipt={r} />
                  </td>
                  <td className="py-2">
                    <Link href={`${base}/${r.id}`} className="font-medium underline">
                      {r.merchant ?? t('receipts.unknown_merchant')}
                    </Link>
                    {r.orderRef && <span className="ml-2 text-xs text-muted">{r.orderRef}</span>}
                  </td>
                  <td className="py-2 text-right">
                    <ReceiptAmount receipt={r} />
                  </td>
                  <td className="py-2">
                    <span className={STATUS_CHIP[r.status]}>{t(`receipts.status.${r.status}`)}</span>
                    {r.likelyDuplicates.length > 0 && (
                      <span className="chip chip-warn ml-1">{t('receipts.likely_duplicate')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
