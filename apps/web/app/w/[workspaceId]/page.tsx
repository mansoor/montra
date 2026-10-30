import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { accountMap, groupAccountsByEntity, netPosition, toTransactionRow } from '@/lib/view-models';
import { Money } from '@/components/money';
import { TransactionList } from '@/components/transaction-list';

export const dynamic = 'force-dynamic';

export default async function HomePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [[workspace, accounts, transactions], { t }] = await Promise.all([
    load((api) =>
      Promise.all([
        api.getWorkspace(workspaceId),
        api.listAccounts(workspaceId),
        api.listTransactions(workspaceId, { limit: 10 }),
      ]),
    ),
    getI18n(),
  ]);
  const groups = groupAccountsByEntity(workspace, accounts);
  const net = netPosition(accounts);
  const names = accountMap(accounts);
  const base = `/w/${workspace.id}`;

  return (
    <div className="space-y-6">
      <section aria-labelledby="net-heading" className="card">
        <h1 id="net-heading" className="text-sm font-medium text-muted">
          {t('home.net_position')}
        </h1>
        {net.length === 0 ? (
          <p className="mt-1 text-2xl font-semibold">—</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-x-6">
            {net.map((n) => (
              <li key={n.currency} className="text-2xl font-semibold">
                <Money amount={n.amount} currency={n.currency} />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted">{t('home.net_position_hint')}</p>
      </section>

      <section aria-labelledby="accounts-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="accounts-heading" className="text-lg font-semibold">
            {t('home.accounts')}
          </h2>
          <Link href={`${base}/accounts/new`} className="btn-secondary">
            {t('nav.add_account')}
          </Link>
        </div>
        {groups.length === 0 && (
          <div className="card text-sm">
            <p>{t('home.no_accounts')}</p>
            <Link
              href={`${base}/accounts/new`}
              className="mt-2 inline-block font-medium text-brand-600 underline"
            >
              {t('home.add_first_account')}
            </Link>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.entityId} className="card">
            <h3 className="mb-2 text-sm font-semibold">
              {g.entityName}{' '}
              <span className="font-normal text-muted">· {t(`entity.type.${g.entityType}`)}</span>
            </h3>
            <ul className="divide-y divide-line">
              {g.accounts.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`${base}/accounts/${a.id}`}
                    className="flex items-center justify-between gap-3 py-2 hover:bg-brand-50"
                  >
                    <span>
                      <span className="block font-medium">{a.name}</span>
                      <span className="text-xs text-muted">
                        {t(`account.kind.${a.kind}`)}
                        {a.last4 ? ` ••${a.last4}` : ''}
                      </span>
                    </span>
                    <span className="text-right">
                      <Money amount={a.balance.amount} currency={a.currency} />
                      {a.type === 'liability' && (
                        <span className="block text-xs text-muted">{t('home.owed')}</span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-labelledby="recent-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="recent-heading" className="text-lg font-semibold">
            {t('home.recent')}
          </h2>
          <Link href={`${base}/transactions`} className="text-sm font-medium text-brand-600 underline">
            {t('home.all_transactions')}
          </Link>
        </div>
        <TransactionList
          rows={transactions.map((r) => toTransactionRow(r, names))}
          hrefBase={`${base}/transactions`}
        />
      </section>
    </div>
  );
}
