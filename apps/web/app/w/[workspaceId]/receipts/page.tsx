import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReceiptListOptions } from '@montra/api-client';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { STATUS_CHIP } from '@/lib/receipts';
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
  const q = sp.q?.trim() || undefined;
  const [page, recommended] = await load((api) =>
    Promise.all([
      api.listReceipts(workspaceId, { ...TABS[tab].query, ...(q ? { q } : {}), limit: 100 }),
      api.listReceiptRecommendations(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const base = `/w/${workspaceId}/receipts`;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">{t('receipts.title')}</h1>
        <Link href={`/w/${workspaceId}/trips`} className="text-sm font-medium text-brand-600 underline">
          {t('trips.title')}
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ReceiptUpload workspaceId={workspaceId} />
        <OrderImport workspaceId={workspaceId} />
      </div>
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
                aria-current={k === tab ? 'page' : undefined}
                className={`rounded-md px-2 py-1 text-sm ${k === tab ? 'bg-brand-50 font-medium text-brand-700' : 'text-muted'}`}
              >
                {t(TABS[k].label)}
              </Link>
            ))}
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
        {page.data.length === 0 ? (
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
