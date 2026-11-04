import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { EmptyState } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Missing receipts' };
export const dynamic = 'force-dynamic';

/** Business expenses over the threshold with no receipt (BIZ-12). */
export default async function MissingReceiptsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [list, categories] = await load((api) =>
    Promise.all([api.getMissingReceipts(workspaceId, { entityId }), api.listCategories(workspaceId)]),
  );
  const { t } = await getI18n();
  const name = new Map(categories.map((c) => [c.id, c.name]));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {t('business.missing_hint')} <Money amount={list.threshold} currency={list.currency} />.{' '}
        <Link href={`/w/${workspaceId}/business/${entityId}/settings`} className="underline">
          {t('business.change_threshold')}
        </Link>
      </p>
      {list.rows.length === 0 ? (
        <EmptyState title={t('business.missing_none')} />
      ) : (
        <section className="card-flush" aria-label={t('business.tab_receipts')}>
          <ul className="divide-y divide-line">
            {list.rows.map((r) => (
              <li
                key={r.transactionId}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                data-testid="missing-receipt"
              >
                <div className="min-w-0">
                  <p className="font-medium">{r.payee ?? t('business.no_name')}</p>
                  <p className="text-xs text-muted">
                    <DateText date={r.date} />
                    {r.categoryId && name.get(r.categoryId) ? ` · ${name.get(r.categoryId)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Money amount={r.amount} currency={list.currency} />
                  <Link
                    href={`/w/${workspaceId}/transactions/${r.transactionId}#receipt`}
                    className="btn-secondary"
                  >
                    {t('business.add_receipt')}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
