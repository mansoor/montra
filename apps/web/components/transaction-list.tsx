import type { TransactionRow } from '@/lib/view-models';
import { Money } from './money';

export function TransactionList({ rows }: { rows: TransactionRow[] }) {
  if (rows.length === 0) return <p className="card text-sm text-muted">No transactions yet.</p>;
  return (
    <ul className="card divide-y divide-line p-0" aria-label="Transactions">
      {rows.map((r) => (
        <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-medium">
              {r.title}
              {r.needsReview && (
                <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-xs font-normal text-brand-700">
                  Needs review
                </span>
              )}
            </p>
            <p className="truncate text-xs text-muted">
              <time dateTime={r.date}>{r.date}</time> · {r.accountName}
              {r.categories.length > 0 && ` · ${r.categories.join(', ')}`}
            </p>
          </div>
          <Money amount={r.amount} currency={r.currency} signed={!r.isTransfer} className="font-medium" />
        </li>
      ))}
    </ul>
  );
}
