import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load } from '@/lib/server-api';
import { Money } from '@/components/money';
import { DateText } from '@/components/i18n';
import { getI18n } from '@/lib/i18n-server';

export const dynamic = 'force-dynamic';

export default async function RegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; accountId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { workspaceId, accountId } = await params;
  const view = (await searchParams).view === 'simple' ? 'simple' : 'ledger';
  const [[accounts, register], { t }] = await Promise.all([
    load((api) => Promise.all([api.listAccounts(workspaceId), api.register(workspaceId, accountId, view)])),
    getI18n(),
  ]);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) notFound();
  const base = `/w/${workspaceId}/accounts/${accountId}`;
  // Newest first for reading; running balances were computed oldest-first by the API.
  const lines = [...register.data].reverse();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{account.name}</h1>
          <p className="text-sm text-muted">
            {account.type === 'liability' ? t('register.owed') : t('register.balance')}:{' '}
            <Money
              amount={account.balance.amount}
              currency={account.currency}
              className="font-semibold text-ink"
            />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/w/${workspaceId}/import?account=${accountId}`} className="btn-primary">
            {t('register.import')}
          </Link>
          <Link href={`${base}/reconcile`} className="btn-secondary">
            {t('register.reconcile')}
          </Link>
          <Link href={`/w/${workspaceId}/imports?account=${accountId}`} className="btn-secondary">
            {t('register.imports')}
          </Link>
        </div>
        <div
          role="group"
          aria-label={t('register.view')}
          className="inline-flex overflow-hidden rounded-md border border-line"
        >
          {(['ledger', 'simple'] as const).map((v) => (
            <Link
              key={v}
              href={`${base}?view=${v}`}
              aria-current={view === v ? 'true' : undefined}
              className={`px-3 py-1.5 text-sm ${view === v ? 'bg-brand-600 text-white' : 'bg-surface hover:bg-brand-50'}`}
            >
              {v === 'ledger' ? t('register.view_ledger') : t('register.view_simple')}
            </Link>
          ))}
        </div>
      </div>

      {lines.length === 0 ? (
        <p className="card text-sm text-muted">{t('register.empty')}</p>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">
              {t(view === 'ledger' ? 'register.caption_ledger' : 'register.caption_simple', {
                account: account.name,
              })}
            </caption>
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-2">
                  {t('fields.date')}
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('fields.description')}
                </th>
                {view === 'ledger' ? (
                  <>
                    <th scope="col" className="px-4 py-2 text-right">
                      {t('register.debit')}
                    </th>
                    <th scope="col" className="px-4 py-2 text-right">
                      {t('register.credit')}
                    </th>
                  </>
                ) : (
                  <th scope="col" className="px-4 py-2 text-right">
                    {t('fields.amount')}
                  </th>
                )}
                <th scope="col" className="px-4 py-2 text-right">
                  {t('register.balance')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} data-testid="register-row">
                  <td className="whitespace-nowrap px-4 py-2">
                    <DateText date={l.date} />
                  </td>
                  <td className="px-4 py-2">
                    {l.description || '—'}
                    {l.cleared === 'reconciled' && (
                      <span
                        role="img"
                        className="ml-2"
                        aria-label={t('register.reconciled')}
                        title={t('register.reconciled')}
                        data-testid="reconciled-lock"
                      >
                        🔒
                      </span>
                    )}
                  </td>
                  {view === 'ledger' ? (
                    <>
                      <td className="px-4 py-2 text-right">
                        {l.debit ? <Money amount={l.debit} currency={account.currency} /> : ''}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {l.credit ? <Money amount={l.credit} currency={account.currency} /> : ''}
                      </td>
                    </>
                  ) : (
                    <td className="px-4 py-2 text-right">
                      <Money amount={l.amount ?? '0'} currency={account.currency} signed />
                    </td>
                  )}
                  <td className="px-4 py-2 text-right font-medium" data-testid="running-balance">
                    <Money amount={l.runningBalance} currency={account.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
