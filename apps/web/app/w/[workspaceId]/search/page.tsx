import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Search' };
export const dynamic = 'force-dynamic';

/** Search across transactions, payees, notes, amounts and receipt text (RPT-05). */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { workspaceId } = await params;
  const q = ((await searchParams).q ?? '').slice(0, 500);
  const results = q ? await load((api) => api.search(workspaceId, q)) : null;
  const { t } = await getI18n();
  const base = `/w/${workspaceId}`;
  const nothing =
    results && !results.transactions.length && !results.payees.length && !results.receipts.length;
  return (
    <div className="space-y-5">
      <PageHeader title={t('search.title')} />
      <form className="card flex flex-wrap items-end gap-2" action={`${base}/search`} role="search">
        <label className="min-w-64 flex-1">
          <span className="field-label">{t('search.label')}</span>
          <input className="input" name="q" type="search" maxLength={500} defaultValue={q} />
        </label>
        <button type="submit" className="btn-primary">
          {t('search.submit')}
        </button>
        <p className="w-full text-xs text-muted">{t('search.syntax')}</p>
      </form>
      {nothing && (
        <p className="card text-sm text-muted" role="status">
          {t('search.nothing')}
        </p>
      )}
      {results && results.payees.length > 0 && (
        <section className="card" aria-labelledby="payees-title">
          <h2 id="payees-title" className="mb-2 text-base font-semibold">
            {t('search.payees')}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {results.payees.map((p) => (
              <li key={p.name}>
                <Link
                  className="chip"
                  href={`${base}/transactions?q=${encodeURIComponent(`"${p.name.replace(/"/g, '')}"`)}`}
                  data-testid="search-payee"
                >
                  {p.name} · {p.count}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {results && results.transactions.length > 0 && (
        <section className="card-flush" aria-labelledby="txns-title">
          <h2 id="txns-title" className="px-4 pt-3 text-base font-semibold">
            {t('search.transactions')}
          </h2>
          <ul className="divide-y divide-line">
            {results.transactions.map((x) => (
              <li
                key={x.id}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2"
                data-testid="search-transaction"
              >
                <div className="min-w-0">
                  <Link className="text-sm underline" href={`${base}/transactions/${x.id}`}>
                    {x.payee || x.description || t('editor.untitled')}
                  </Link>
                  <p className="text-xs text-muted">
                    <DateText date={x.date} />
                    {x.matchedNote && ` · ${t('search.note')}: ${x.matchedNote}`}
                  </p>
                </div>
                {x.amount && x.currency && <Money amount={x.amount} currency={x.currency} />}
              </li>
            ))}
          </ul>
          {results.moreTransactions && <p className="px-4 pb-3 text-xs text-muted">{t('search.more')}</p>}
        </section>
      )}
      {results && results.receipts.length > 0 && (
        <section className="card-flush" aria-labelledby="receipts-title">
          <h2 id="receipts-title" className="px-4 pt-3 text-base font-semibold">
            {t('search.receipts')}
          </h2>
          <ul className="divide-y divide-line">
            {results.receipts.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2"
                data-testid="search-receipt"
              >
                <div className="min-w-0">
                  <Link className="text-sm underline" href={`${base}/receipts/${r.id}`}>
                    {r.merchant ?? t('search.receipt')}
                  </Link>
                  {r.snippet && <p className="text-xs text-muted">{r.snippet}</p>}
                </div>
                {r.total && r.currency && <Money amount={r.total} currency={r.currency} />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
