'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { formatMinor, minorToInput, parseAmountInput } from '@/lib/money';

export interface UpcomingItem {
  id: string;
  date: string;
  title: string;
  templateName: string | null;
  accountName: string;
  amount: { amount: string; currency: string } | null;
}

const abs = (n: bigint) => (n < 0n ? -n : n);

/** Scheduled occurrences with Confirm and an optional actual-amount override. */
export function UpcomingList({ workspaceId, items }: { workspaceId: string; items: UpcomingItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function materialize() {
    setBusy('materialize');
    try {
      const r = await browserApi.materializeRecurring(workspaceId);
      setMessage(
        r.created + r.posted === 0 ? 'Nothing new is due.' : `Created ${r.created}, posted ${r.posted}.`,
      );
      router.refresh();
    } catch (err) {
      setMessage(friendlyMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function confirm(item: UpcomingItem) {
    const raw = overrides[item.id];
    let amount: { amount: string; currency: string } | undefined;
    if (raw !== undefined && item.amount) {
      const parsed = parseAmountInput(raw, item.amount.currency);
      if (!parsed.ok) return setErrors((e) => ({ ...e, [item.id]: parsed.error }));
      // Keep the template's direction (money out stays money out).
      const sign = BigInt(item.amount.amount) < 0n ? -1n : 1n;
      amount = { amount: (abs(parsed.minor) * sign).toString(), currency: item.amount.currency };
    }
    setBusy(item.id);
    setErrors((e) => ({ ...e, [item.id]: '' }));
    try {
      await browserApi.confirmOccurrence(workspaceId, item.id, amount ? { amount } : {});
      setMessage(`Confirmed ${item.title}.`);
      router.refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [item.id]: friendlyMessage(err) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={materialize}>
          Create due occurrences now
        </button>
        <span role="status" className="text-sm text-muted">
          {message}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="card text-sm text-muted">
          Nothing scheduled. Recurring items appear here when they’re due.
        </p>
      ) : (
        <ul className="card divide-y divide-line p-0" aria-label="Scheduled occurrences">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-end gap-3 px-4 py-3" data-testid="upcoming-row">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{item.title}</p>
                <p className="text-xs text-muted">
                  <time dateTime={item.date}>{item.date}</time>
                  {item.accountName && ` · ${item.accountName}`}
                  {item.amount && ` · expected ${formatMinor(item.amount.amount, item.amount.currency)}`}
                </p>
              </div>
              {item.amount && (
                <div>
                  <label htmlFor={`amt-${item.id}`} className="field-label">
                    Actual amount
                  </label>
                  <input
                    id={`amt-${item.id}`}
                    className="input num w-32"
                    inputMode="decimal"
                    value={
                      overrides[item.id] ??
                      minorToInput(abs(BigInt(item.amount.amount)), item.amount.currency)
                    }
                    onChange={(e) => setOverrides((o) => ({ ...o, [item.id]: e.target.value }))}
                    aria-invalid={errors[item.id] ? 'true' : undefined}
                    aria-describedby={errors[item.id] ? `err-${item.id}` : undefined}
                  />
                </div>
              )}
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null}
                onClick={() => confirm(item)}
                aria-label={`Confirm ${item.title} on ${item.date}`}
              >
                Confirm
              </button>
              {errors[item.id] && (
                <p id={`err-${item.id}`} role="alert" className="field-error w-full">
                  {errors[item.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
