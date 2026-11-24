import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
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
import { ReceiptList } from '@/components/receipts/receipt-list';
import { ListFilterBar } from '@/components/list-filter-bar';
import { FILTER_PARAMS, listApiQuery, parseListFilters } from '@/lib/list-filters';

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
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const base = `/w/${workspaceId}/receipts`;
  // A link from before the search moved into the filters (`?q=`) opens on the same words.
  if (sp.q?.trim() && !sp.text) {
    const { q: words, ...rest } = sp;
    const keep = Object.entries(rest).filter((e): e is [string, string] => e[1] !== undefined);
    redirect(`${base}?${new URLSearchParams([...keep, ['text', words!.trim()]]).toString()}`);
  }
  const { filters } = parseListFilters(sp);
  // Words on the receipt look in every list unless one was chosen, as the search did.
  const tab: TabKey = sp.tab && sp.tab in TABS ? (sp.tab as TabKey) : filters.text ? 'all' : 'inbox';
  // Deleted receipts: restore, or delete a personal one for good (BAK-06, RCP-10).
  const inTrash = sp.tab === 'trash';
  const { t, locale } = await getI18n();
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  // Receipts have no money in or out: a return is a negative total on the same kind of receipt.
  const narrow = listApiQuery(
    { ...filters, dir: undefined },
    {
      timeZone: workspace.timeZone,
      currency: workspace.baseCurrency,
      locale,
    },
  );
  // What every page of the list is asked for with; "Load more" sends it again with the cursor.
  const query: ReceiptListOptions = {
    ...TABS[tab].query,
    ...(filters.text ? { q: filters.text } : {}),
    ...narrow,
    limit: 100,
  };
  const [page, recommended, reading, trash] = await load((api) =>
    Promise.all([
      api.listReceipts(workspaceId, query),
      api.listReceiptRecommendations(workspaceId),
      // Receipts still being read aren't in any tab but All, so they're listed above the tabs.
      api.listReceipts(workspaceId, { status: 'processing', limit: 100 }),
      inTrash ? api.listTrash(workspaceId) : Promise.resolve(null),
    ]),
  );
  // The tabs keep the filters.
  const kept: Record<string, string> = {};
  for (const k of FILTER_PARAMS) if (sp[k]) kept[k] = sp[k];
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="receipt-list" className="text-lg font-semibold">
            {t(inTrash ? 'receipts.tab.trash' : TABS[tab].label)}
          </h2>
          <nav aria-label={t('receipts.tabs')}>
            <ul className="tabs border-b-0">
              {(Object.keys(TABS) as TabKey[]).map((k) => (
                <li key={k}>
                  <Link
                    href={`${base}?${new URLSearchParams({ ...kept, tab: k }).toString()}`}
                    aria-current={k === tab && !inTrash ? 'page' : undefined}
                    className="tab"
                  >
                    {t(TABS[k].label)}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href={`${base}?tab=trash`}
                  aria-current={inTrash ? 'page' : undefined}
                  className="tab"
                  data-testid="receipts-trash-tab"
                >
                  {t('receipts.tab.trash')}
                </Link>
              </li>
            </ul>
          </nav>
        </div>
        {trash ? (
          <TrashList
            workspaceId={workspaceId}
            items={receiptsInTrash(trash)}
            canDelete={isAdminRole(workspace.role)}
            showDate
            showEmpty={false}
          />
        ) : (
          <>
            <ListFilterBar screen="receipts" workspace={workspace} showText />
            <ReceiptList
              workspaceId={workspaceId}
              first={page.data}
              nextCursor={page.nextCursor}
              query={query}
            />
          </>
        )}
      </section>
    </div>
  );
}
