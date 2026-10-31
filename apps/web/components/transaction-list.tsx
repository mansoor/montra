'use client';

import Link from 'next/link';
import type { TransactionRow } from '@/lib/view-models';
import { DateText, useI18n } from './i18n';
import { Money } from './money';

export function TransactionList({ rows, hrefBase }: { rows: TransactionRow[]; hrefBase?: string }) {
  const { t } = useI18n();
  if (rows.length === 0) return <p className="card text-sm text-muted">{t('transactions.empty')}</p>;
  return (
    <ul className="card divide-y divide-line p-0" aria-label={t('transactions.list_label')}>
      {rows.map((r) => (
        <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-medium">
              {hrefBase ? (
                <Link href={`${hrefBase}/${r.id}`} className="hover:underline">
                  <RowTitle row={r} />
                </Link>
              ) : (
                <RowTitle row={r} />
              )}
              {r.needsReview && <ReviewBadge />}
            </p>
            <p className="truncate text-xs text-muted">
              <DateText date={r.date} /> · {r.accountName}
              {r.categories.length > 0 && <RowCategories row={r} />}
            </p>
          </div>
          <RowAmount row={r} />
        </li>
      ))}
    </ul>
  );
}

/** Payee or description (or the enriched merchant name); untitled rows get a translated placeholder. */
export function RowTitle({ row }: { row: TransactionRow }) {
  const { t } = useI18n();
  return (
    <>
      {row.merchant?.name ||
        row.title ||
        (row.isTransfer ? t('transactions.transfer') : t('transactions.no_payee'))}
    </>
  );
}

/** " · Groceries", with the reason it was chosen on hover and for screen readers (AI-06). */
export function RowCategories({ row }: { row: TransactionRow }) {
  const { t } = useI18n();
  return (
    <span title={row.explanation ?? undefined} data-testid="row-categories">
      {` · ${row.categories.join(', ')}`}
      {row.explanation && (
        <span className="sr-only">
          {' '}
          ({t('review.why')} {row.explanation})
        </span>
      )}
    </span>
  );
}

export function ReviewBadge() {
  const { t } = useI18n();
  return (
    <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-xs font-normal text-brand-700">
      {t('transactions.needs_review')}
    </span>
  );
}

export function RowAmount({ row }: { row: TransactionRow }) {
  if (row.amount === null) return <span className="text-muted">—</span>;
  return (
    <Money amount={row.amount} currency={row.currency} signed={!row.isTransfer} className="font-medium" />
  );
}
