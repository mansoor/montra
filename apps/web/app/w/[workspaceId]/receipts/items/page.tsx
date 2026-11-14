import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ITEM_PERIODS, asItemPeriod, itemPeriodFrom, widerItemPeriod } from '@/lib/receipts';
import { Money } from '@/components/money';
import { DateText } from '@/components/i18n';

export const metadata: Metadata = { title: 'Search by item' };
export const dynamic = 'force-dynamic';

/**
 * Search by item (RCP-09): what was spent on an item ("milk") and every receipt it's on, with the store, the date, the
 * item's amount and the receipt's total. Three months first; the period widens up to every receipt.
 */
export default async function ReceiptItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ q?: string; period?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const period = asItemPeriod(sp.period);
  const result = await load(async (api) => {
    if (!q) return null;
    const ws = await api.getWorkspace(workspaceId);
    return api.searchReceiptItems(workspaceId, { q, from: itemPeriodFrom(todayIn(ws.timeZone), period) });
  });
  const { t } = await getI18n();
  const base = `/w/${workspaceId}/receipts`;
  const href = (p: string) => `${base}/items?q=${encodeURIComponent(q ?? '')}&period=${p}`;
  const wider = widerItemPeriod(period);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={base} className="text-sm underline">
          {t('receipts.back')}
        </Link>
        <h1 className="page-title">{t('receipts.items.title')}</h1>
      </div>
      <p className="text-sm text-muted">{t('receipts.items.hint')}</p>
      <form action={`${base}/items`} className="flex flex-wrap items-center gap-2" role="search">
        <input
          className="input"
          type="search"
          name="q"
          defaultValue={q}
          maxLength={100}
          placeholder={t('receipts.items.field')}
          aria-label={t('receipts.items.field')}
        />
        <select
          className="input w-auto"
          name="period"
          defaultValue={period}
          aria-label={t('receipts.items.period')}
        >
          {ITEM_PERIODS.map((p) => (
            <option key={p} value={p}>
              {t(`receipts.items.period_${p}`)}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-primary">
          {t('receipts.search_go')}
        </button>
      </form>
      {result && (
        <>
          <section className="card space-y-1" data-testid="item-summary" aria-live="polite">
            {result.totals.length === 0 ? (
              <p className="text-sm text-muted">{t('receipts.items.none', { item: result.query })}</p>
            ) : (
              result.totals.map((s) => (
                <p key={s.currency}>
                  <Money amount={s.amount} currency={s.currency} className="text-2xl font-semibold" />{' '}
                  {t('receipts.items.summary', { item: result.query, items: s.items, receipts: s.receipts })}
                </p>
              ))
            )}
            <p className="text-xs text-muted">
              {period === 'all' ? (
                t('receipts.items.all_time')
              ) : (
                <>
                  {t('receipts.items.since')} <DateText date={result.from} />
                </>
              )}
            </p>
          </section>
          {result.receipts.length > 0 && (
            <table className="tbl text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1">{t('receipts.date')}</th>
                  <th className="py-1">{t('receipts.merchant')}</th>
                  <th className="py-1">{t('receipts.items.item')}</th>
                  <th className="py-1 text-right">{t('receipts.items.amount')}</th>
                  <th className="py-1 text-right">{t('receipts.total')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.receipts.map((r) => (
                  <tr key={r.receiptId} data-testid="item-receipt">
                    <td className="py-2">
                      <DateText date={r.receiptDate} />
                    </td>
                    <td className="py-2">
                      <Link href={`${base}/${r.receiptId}`} className="font-medium underline">
                        {r.merchant ?? t('receipts.unknown_merchant')}
                      </Link>
                    </td>
                    <td className="py-2">{r.items.map((x) => x.name).join(', ')}</td>
                    <td className="py-2 text-right">
                      <Money amount={r.itemsAmount} currency={r.currency} />
                    </td>
                    <td className="py-2 text-right">
                      {r.total ? (
                        <Money amount={r.total} currency={r.currency} />
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.more && <p className="text-xs text-muted">{t('receipts.items.more')}</p>}
          {wider && (
            <Link href={href(wider)} className="btn-secondary inline-block" data-testid="item-wider">
              {t('receipts.items.wider', { period: t(`receipts.items.period_${wider}`) })}
            </Link>
          )}
        </>
      )}
    </div>
  );
}
