'use client';

import { useCallback, useMemo, type ReactNode } from 'react';
import type {
  AccountDto,
  CategoryDto,
  FamilyMemberDto,
  TransactionDto,
  TransactionListOptions,
  WorkspaceDto,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { listFooter } from '@/lib/paging';
import { accountMap, toTransactionRow } from '@/lib/view-models';
import { useI18n } from './i18n';
import { ListWindowFooter } from './list-filter-bar';
import { TransactionsTable } from './transactions-table';
import { usePager } from './use-pager';

const txnId = (t: TransactionDto) => t.id;

/**
 * The transaction list a page at a time: the first page comes from the server, "Load more" asks for the next with the
 * same filters. Once the window is all loaded, the line under it offers Show older.
 */
export function PagedTransactions({
  workspace,
  first,
  nextCursor,
  query,
  accounts,
  categories,
  members,
  trash,
  empty,
}: {
  workspace: WorkspaceDto;
  first: TransactionDto[];
  nextCursor: string | null;
  /** What the first page was asked for with, filters and all. */
  query: TransactionListOptions;
  accounts: AccountDto[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
  trash: boolean;
  empty: ReactNode;
}) {
  const { t } = useI18n();
  const fetchPage = useCallback(
    (cursor: string) => browserApi.listTransactionsPage(workspace.id, { ...query, cursor }),
    [workspace.id, query],
  );
  const { rows, cursor, loading, error, loadMore } = usePager(first, nextCursor, fetchPage, txnId);
  const names = useMemo(() => accountMap(accounts), [accounts]);
  return (
    <>
      <TransactionsTable
        workspace={workspace}
        rows={rows.map((r) => toTransactionRow(r, names))}
        categories={categories}
        members={members}
        trash={trash}
        empty={empty}
      />
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {listFooter(cursor) === 'more' ? (
        <button
          type="button"
          className="btn-secondary"
          disabled={loading}
          onClick={() => void loadMore()}
          data-testid="load-more"
        >
          {loading ? t('common.loading') : t('filters.load_more')}
        </button>
      ) : (
        <ListWindowFooter screen="transactions" />
      )}
    </>
  );
}
