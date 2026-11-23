import type { Metadata } from 'next';
import Link from 'next/link';
import { canSpendFrom, todayIn } from '@montra/domain';
import type { TransactionListOptions } from '@montra/api-client';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { FILTER_PARAMS, listApiQuery, parseListFilters } from '@/lib/list-filters';
import { accountMap, toTransactionRow } from '@/lib/view-models';
import { ListEmpty, ListFilterBar, ListWindowFooter } from '@/components/list-filter-bar';
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

/** The most the list shows at once; the filters narrow it. */
const LIMIT = 200;

export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const raw = sp.filter;
  const filter: FilterKey = raw && raw in FILTERS ? (raw as FilterKey) : 'all';
  // Drill-down from the dashboard, budget and flow screens (FLOW-01/02): the transactions behind a number. Its dates
  // are the filter bar's custom range.
  const drill = {
    entityId: sp.entityId,
    memberId: sp.memberId,
    propertyId: sp.propertyId,
    spentBy: sp.spentBy,
    q: sp.q,
    categoryIds: sp.categoryIds ? sp.categoryIds.split(',').filter(Boolean) : undefined,
    accountIds: sp.accountIds ? sp.accountIds.split(',').filter(Boolean) : undefined,
  };
  const drilled = Object.values(drill).some((v) => v !== undefined);
  const { filters } = parseListFilters(sp);
  const { t, locale } = await getI18n();
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const narrow = listApiQuery(filters, {
    timeZone: workspace.timeZone,
    currency: workspace.baseCurrency,
    locale,
  });
  const [accounts, categories, members, transactions] = await load((api) =>
    Promise.all([
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
      api.listTransactions(workspaceId, {
        limit: LIMIT,
        ...FILTERS[filter].query,
        ...drill,
        ...narrow,
        ...(filters.account ? { accountId: filters.account } : {}),
        ...(filters.category ? { categoryIds: [filters.category] } : {}),
      }),
    ]),
  );
  const open = accounts.filter((a) => !a.archived);
  const today = todayIn(workspace.timeZone);
  const names = accountMap(accounts);
  const base = `/w/${workspace.id}`;
  // The tabs keep the filters.
  const tabHref = (k: FilterKey) => {
    const q = new URLSearchParams();
    for (const p of FILTER_PARAMS) if (sp[p]) q.set(p, sp[p]);
    if (k !== 'all') q.set('filter', k);
    const s = q.toString();
    return s ? `${base}/transactions?${s}` : `${base}/transactions`;
  };

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
          </span>
          <Link href={`${base}/transactions`} className="btn-secondary">
            {t('transactions.clear_filter')}
          </Link>
        </p>
      )}
      <QuickAdd
        workspace={workspace}
        accounts={open.filter(canSpendFrom)}
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
                  <Link href={tabHref(k)} aria-current={filter === k ? 'page' : undefined} className="tab">
                    {t(FILTERS[k].label)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <ListFilterBar
          screen="transactions"
          workspace={workspace}
          merchantHint={t('filters.merchant_hint')}
          showDirection
          accounts={open}
          categories={categories}
        />
        <TransactionsTable
          workspace={workspace}
          rows={transactions.map((t) => toTransactionRow(t, names))}
          categories={categories}
          members={members}
          trash={filter === 'trash'}
          empty={
            <ListEmpty
              screen="transactions"
              fallback={filter === 'trash' ? t('transactions.trash_empty') : t('transactions.none_here')}
            />
          }
        />
        {transactions.length >= LIMIT && (
          <p className="text-sm text-muted">{t('filters.limit_reached', { count: LIMIT })}</p>
        )}
        <ListWindowFooter screen="transactions" />
      </section>
    </div>
  );
}
