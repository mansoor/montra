'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import type { ReceiptDto, ReceiptListOptions } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { listFooter } from '@/lib/paging';
import { STATUS_CHIP } from '@/lib/receipts';
import { useI18n } from '../i18n';
import { ListEmpty, ListWindowFooter } from '../list-filter-bar';
import { usePager } from '../use-pager';
import { ReceiptAmount, ReceiptDate } from './receipt-cells';

const receiptId = (r: ReceiptDto) => r.id;

/**
 * The receipt list a page at a time: the first page from the server, "Load more" for the next with the same tab, search
 * and filters. Once the window is all loaded, the line under it offers Show older.
 */
export function ReceiptList({
  workspaceId,
  first,
  nextCursor,
  query,
}: {
  workspaceId: string;
  first: ReceiptDto[];
  nextCursor: string | null;
  /** What the first page was asked for with. */
  query: ReceiptListOptions;
}) {
  const { t } = useI18n();
  const fetchPage = useCallback(
    (cursor: string) => browserApi.listReceipts(workspaceId, { ...query, cursor }),
    [workspaceId, query],
  );
  const { rows, cursor, loading, error, loadMore } = usePager(first, nextCursor, fetchPage, receiptId);
  const base = `/w/${workspaceId}/receipts`;
  return (
    <>
      {rows.length === 0 ? (
        <ListEmpty screen="receipts" fallback={t('receipts.empty')} />
      ) : (
        <table className="tbl text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1">{t('receipts.date')}</th>
              <th className="py-1">{t('receipts.merchant')}</th>
              <th className="py-1 text-right">{t('receipts.total')}</th>
              <th className="py-1">{t('receipts.status_col')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} data-testid="receipt-row">
                <td className="py-2">
                  <ReceiptDate receipt={r} />
                </td>
                <td className="py-2">
                  <Link href={`${base}/${r.id}`} className="font-medium underline">
                    {r.merchant ?? t('receipts.unknown_merchant')}
                  </Link>
                  {r.orderRef && <span className="ml-2 text-xs text-muted">{r.orderRef}</span>}
                </td>
                <td className="py-2 text-right">
                  <ReceiptAmount receipt={r} />
                </td>
                <td className="py-2">
                  <span className={STATUS_CHIP[r.status]}>{t(`receipts.status.${r.status}`)}</span>
                  {r.likelyDuplicates.length > 0 && (
                    <span className="chip chip-warn ml-1">{t('receipts.likely_duplicate')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
        <ListWindowFooter screen="receipts" />
      )}
    </>
  );
}
