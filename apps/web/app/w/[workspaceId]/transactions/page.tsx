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
  searchParams: Promise<{
    filter?: string;
    entityId?: string;
    memberId?: string;
    propertyId?: string;
    categoryIds?: string;
    accountIds?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const raw = sp.filter;
  const filter: FilterKey = raw && raw in FILTERS ? (raw as FilterKey) : 'all';
  // Drill-down from the dashboard, budget and flow screens (FLOW-01/02): the transactions behind a number.
  const drill = {
    entityId: sp.entityId,
    memberId: sp.memberId,
    propertyId: sp.propertyId,
    categoryIds: sp.categoryIds ? sp.categoryIds.split(',').filter(Boolean) : undefined,
    accountIds: sp.accountIds ? sp.accountIds.split(',').filter(Boolean) : undefined,
    from: sp.from,
    to: sp.to,
  };
  const drilled = Object.values(drill).some((v) => v !== undefined);
  const [workspace, accounts, categories, members, transactions] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
      api.listTransactions(workspaceId, { limit: 200, ...FILTERS[filter].query, ...drill }),
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
        <h1 className="page-title">{t('nav.transactions')}</h1>
        <Link href={`${base}/journal/new`} className="text-sm font-medium text-brand-600 underline">
          {t('journal.new')}
        </Link>
      </div>
      {drilled && (
        <p role="status" className="card flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {t('transactions.drilled')}
            {drill.memberId
              ? ` · ${drill.memberId === 'household' ? t('members.household') : (members.find((m) => m.id === drill.memberId)?.name ?? '')}`
              : ''}
            {drill.from && drill.to ? ` · ${drill.from} – ${drill.to}` : ''}
          </span>
          <Link href={`${base}/transactions`} className="btn-secondary">
            {t('transactions.clear_filter')}
          </Link>
        </p>
      )}
      <QuickAdd
        workspace={workspace}
        accounts={open}
        categories={categories}
        members={members}
        today={today}
      />
      <TransferForm workspace={workspace} accounts={open} today={today} />
      <section aria-labelledby="list-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="list-heading" className="text-lg font-semibold">
            {t(FILTERS[filter].label)}
          </h2>
          <nav aria-label={t('transactions.filter.label')}>
            <ul className="tabs border-b-0">
              {(Object.keys(FILTERS) as FilterKey[]).map((k) => (
                <li key={k}>
                  <Link
                    href={k === 'all' ? `${base}/transactions` : `${base}/transactions?filter=${k}`}
                    aria-current={filter === k ? 'page' : undefined}
                    className="tab"
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
