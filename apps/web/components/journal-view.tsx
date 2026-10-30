import type { JournalEntryDetailDto } from '@montra/api-client';
import { Money } from './money';

/** Double-entry view of one journal entry (DE-07): debits equal credits. */
export function JournalView({ entry, entityName }: { entry: JournalEntryDetailDto; entityName: string }) {
  const currency = entry.postings[0]?.currency ?? 'USD';
  const total = entry.postings.reduce((a, p) => a + BigInt(p.debit ?? '0'), 0n);
  return (
    <div className="card overflow-x-auto p-0" data-testid="journal-entry">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 text-sm">
        <span className="font-medium">{entityName}</span>
        <time dateTime={entry.date} className="text-muted">
          {entry.date}
        </time>
        <span className="text-muted">{entry.kind.replace('_', ' ')}</span>
        {entry.locked && (
          <span className="rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-700">
            Locked (reconciled)
          </span>
        )}
      </div>
      <table className="w-full min-w-[30rem] text-sm">
        <caption className="sr-only">Journal entry on {entry.date}</caption>
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-2">
              Account
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              Debit
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              Credit
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {entry.postings.map((p) => (
            <tr key={p.lineNo}>
              <td className="px-4 py-2">
                {p.accountName}
                <span className="ml-2 text-xs text-muted">{p.accountType}</span>
                {p.memo && <span className="block text-xs text-muted">{p.memo}</span>}
              </td>
              <td className="px-4 py-2 text-right">
                {p.debit && <Money amount={p.debit} currency={p.currency} />}
              </td>
              <td className="px-4 py-2 text-right">
                {p.credit && <Money amount={p.credit} currency={p.currency} />}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-line font-medium">
          <tr>
            <th scope="row" className="px-4 py-2 text-left">
              Total
            </th>
            <td className="px-4 py-2 text-right">
              <Money amount={total} currency={currency} />
            </td>
            <td className="px-4 py-2 text-right">
              <Money amount={total} currency={currency} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
