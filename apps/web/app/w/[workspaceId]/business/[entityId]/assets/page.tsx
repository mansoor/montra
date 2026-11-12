import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { AssetRegister } from '@/components/business/asset-register';
import { Money } from '@/components/money';
import { StatTile } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Assets' };
export const dynamic = 'force-dynamic';

/** The asset register (BIZ-16, BIZ-17): what the business owns, its depreciation and who holds it. */
export default async function AssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ transactionId?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const { transactionId } = await searchParams;
  const [workspace, list] = await load((api) =>
    Promise.all([api.getWorkspace(workspaceId), api.listAssets(workspaceId, { entityId })]),
  );
  // "Record as an asset?" from a transaction: the form starts from that purchase.
  const purchase = transactionId
    ? await load((api) => api.getTransaction(workspaceId, transactionId)).catch(() => null)
    : null;
  const { t } = await getI18n();
  const today = todayIn(workspace.timeZone);
  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3" aria-label={t('assets.totals')}>
        <StatTile
          label={t('assets.total_cost')}
          value={<Money amount={list.totals.cost} currency={list.currency} />}
        />
        <StatTile
          label={t('assets.total_accumulated')}
          value={<Money amount={list.totals.accumulated} currency={list.currency} />}
        />
        <StatTile
          label={t('assets.total_book_value')}
          value={<Money amount={list.totals.bookValue} currency={list.currency} />}
        />
      </section>
      <AssetRegister
        workspaceId={workspaceId}
        entityId={entityId}
        list={list}
        today={today}
        purchase={
          purchase && purchase.amount
            ? {
                id: purchase.id,
                date: purchase.date,
                payee: purchase.payee ?? purchase.description,
                amount: purchase.amount.amount.replace('-', ''),
              }
            : null
        }
      />
      <p className="text-xs text-muted">{t('assets.disclaimer')}</p>
    </div>
  );
}
