import type { Metadata } from 'next';
import Link from 'next/link';
import { summarizeAccounts, type CurrencyTotal } from '@montra/domain';
import { getI18n } from '@/lib/i18n-server';
import { load } from '@/lib/server-api';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Accounts' };
export const dynamic = 'force-dynamic';

function Totals({ totals }: { totals: CurrencyTotal[] }) {
  return (
    <span className="flex flex-col items-end">
      {totals.length === 0 ? (
        <span>—</span>
      ) : (
        totals.map((n) => (
          <span key={n.currency}>
            <Money amount={n.amount} currency={n.currency} />
          </span>
        ))
      )}
    </span>
  );
}

/** Every account by kind, with totals for each kind and for everything. */
export default async function AccountsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, accounts, { t }] = await Promise.all([
    load((api) => api.getWorkspace(workspaceId)),
    load((api) => api.listAccounts(workspaceId)),
    getI18n(),
  ]);
  const base = `/w/${workspaceId}`;
  const summary = summarizeAccounts(accounts);
  // Only worth saying which books an account is in when there's more than one set.
  const books = workspace.entities.length > 1 ? new Map(workspace.entities.map((e) => [e.id, e.name])) : null;
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('accounts.title')}
        subtitle={t('accounts.subtitle')}
        actions={
          <Link href={`${base}/accounts/new`} className="btn-primary">
            {t('nav.add_account')}
          </Link>
        }
      />
      {summary.groups.length === 0 && (
        <p className="card text-sm" role="status">
          {t('home.no_accounts')}
        </p>
      )}
      {summary.groups.map((g) => (
        <section
          key={g.kind}
          className="card-flush"
          aria-labelledby={`kind-${g.kind}`}
          data-testid="accounts-group"
        >
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id={`kind-${g.kind}`} className="text-base font-semibold">
              {t(`account.kind.${g.kind}`)}
            </h2>
            <span className="text-right font-semibold" data-testid="accounts-group-total">
              <Totals totals={g.totals} />
              {g.type === 'liability' && (
                <span className="block text-xs font-normal text-muted">{t('home.owed')}</span>
              )}
            </span>
          </header>
          <ul className="divide-y divide-line">
            {g.accounts.map((a) => (
              <li key={a.id}>
                <Link
                  href={`${base}/accounts/${a.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-brand-50"
                  data-testid="accounts-row"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {[a.institution, a.last4 ? `••${a.last4}` : null, books?.get(a.entityId)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <Money amount={a.balance.amount} currency={a.currency} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {summary.groups.length > 0 && (
        <section className="card space-y-2" aria-labelledby="accounts-all" data-testid="accounts-summary">
          <h2 id="accounts-all" className="text-base font-semibold">
            {t('accounts.all')}
          </h2>
          <dl className="space-y-2">
            <div className="flex items-start justify-between gap-3 text-sm" data-testid="accounts-assets">
              <dt>{t('accounts.total_assets')}</dt>
              <dd>
                <Totals totals={summary.assets} />
              </dd>
            </div>
            <div
              className="flex items-start justify-between gap-3 text-sm"
              data-testid="accounts-liabilities"
            >
              <dt>{t('accounts.total_liabilities')}</dt>
              <dd>
                <Totals totals={summary.liabilities} />
              </dd>
            </div>
            <div
              className="flex items-start justify-between gap-3 border-t border-line pt-2 font-display text-xl font-semibold"
              data-testid="accounts-net"
            >
              <dt>{t('accounts.net')}</dt>
              <dd>
                <Totals totals={summary.net} />
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted">{t('accounts.net_hint')}</p>
        </section>
      )}
      <p className="text-sm">
        <Link className="underline" href={`${base}/settings?tab=accounts`}>
          {t('accounts.manage')}
        </Link>
      </p>
    </div>
  );
}
