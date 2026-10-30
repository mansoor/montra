import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import type { TransactionListOptions } from '@montra/api-client';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { accountMap, toTransactionRow } from '@/lib/view-models';
import { QuickAdd } from '@/components/quick-add';
import { TransferForm } from '@/components/transfer-form';
import { TransactionsTable } from '@/components/transactions-table';

export const metadata: Metadata = { title: 'Transactions' };
export const dynamic = 'force-dynamic';

const FILTERS = {
  all: { label: 'transactions.filter.all', query: {} },
  review: { label: 'transactions.filter.review', query: { reviewState: 'needs_review' } },
  scheduled: { label: 'transactions.filter.scheduled', query: { status: 'scheduled' } },
  trash: { label: 'transactions.filter.trash', query: { trash: true } },
} satisfies Record<string, { label: string; query: TransactionListOptions }>;
type FilterKey = keyof typeof FILTERS;

export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { workspaceId } = await params;
  const raw = (await searchParams).filter;
  const filter: FilterKey = raw && raw in FILTERS ? (raw as FilterKey) : 'all';
  const [workspace, accounts, categories, members, transactions] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
      api.listTransactions(workspaceId, { limit: 200, ...FILTERS[filter].query }),
    ]),
  );
  const open = accounts.filter((a) => !a.archived);
  const { t } = await getI18n();
  const today = todayIn(workspace.timeZone);
  const names = accountMap(accounts);
  const base = `/w/${workspace.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('nav.transactions')}</h1>
        <Link href={`${base}/journal/new`} className="text-sm font-medium text-brand-600 underline">
          {t('journal.new')}
        </Link>
      </div>
      <QuickAdd workspace={workspace} accounts={open} categories={categories} today={today} />
      <TransferForm workspace={workspace} accounts={open} today={today} />
      <section aria-labelledby="list-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="list-heading" className="text-lg font-semibold">
            {t(FILTERS[filter].label)}
          </h2>
          <nav aria-label={t('transactions.filter.label')}>
            <ul className="flex flex-wrap gap-1">
              {(Object.keys(FILTERS) as FilterKey[]).map((k) => (
                <li key={k}>
                  <Link
                    href={k === 'all' ? `${base}/transactions` : `${base}/transactions?filter=${k}`}
                    aria-current={filter === k ? 'page' : undefined}
                    className={`rounded-md px-2 py-1 text-sm ${filter === k ? 'bg-brand-600 text-white' : 'border border-line bg-surface hover:bg-brand-50'}`}
                  >
                    {t(FILTERS[k].label)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <TransactionsTable
          workspace={workspace}
          rows={transactions.map((t) => toTransactionRow(t, names))}
          categories={categories}
          members={members}
          trash={filter === 'trash'}
        />
      </section>
    </div>
  );
}
