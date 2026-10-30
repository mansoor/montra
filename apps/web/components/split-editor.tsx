'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { evaluateSplits, type SplitLine } from '@/lib/splits';
import { formatMinor } from '@/lib/money';
import type { CategoryGroup } from '@/lib/view-models';

let counter = 0;
const newLine = (accountId = '', amount = ''): SplitLine => ({ key: `line-${++counter}`, accountId, amount });

/**
 * Split editor dialog (TXN-03): categories from every entity, so one purchase can be split between
 * Personal and Business. Save is only enabled when the lines add up to the transaction total.
 */
export function SplitEditor({
  open,
  total,
  currency,
  groups,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  total: string;
  currency: string;
  groups: CategoryGroup[];
  initial: SplitLine[];
  onSave: (lines: SplitLine[]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [lines, setLines] = useState<SplitLine[]>(() => (initial.length ? initial : [newLine(), newLine()]));

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setLines(initial.length ? initial : [newLine('', total), newLine()]);
      d.showModal();
    } else if (!open && d.open) d.close();
    // Re-seed only when the dialog opens, not on every parent render.
  }, [open]); // intentionally omits initial/total

  const state = evaluateSplits(total, lines, currency);
  const update = (key: string, patch: Partial<SplitLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40"
    >
      <form
        method="dialog"
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (state.balanced) onSave(lines);
        }}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Split transaction
        </h2>
        <p className="text-sm text-muted">
          Total {state.total === null ? '—' : formatMinor(state.total, currency)}. Lines can belong to
          different books (Personal, Business, Rental).
        </p>
        <ul className="space-y-3">
          {lines.map((l, i) => (
            <li key={l.key} className="grid grid-cols-[1fr_8rem_auto] items-start gap-2">
              <div>
                <label htmlFor={`${l.key}-cat`} className="sr-only">
                  Category for line {i + 1}
                </label>
                <select
                  id={`${l.key}-cat`}
                  className="input"
                  value={l.accountId}
                  onChange={(e) => update(l.key, { accountId: e.target.value })}
                  aria-invalid={l.amount && !l.accountId ? 'true' : undefined}
                >
                  <option value="">Choose category…</option>
                  {groups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${l.key}-amt`} className="sr-only">
                  Amount for line {i + 1}
                </label>
                <input
                  id={`${l.key}-amt`}
                  className="input num text-right"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={l.amount}
                  onChange={(e) => update(l.key, { amount: e.target.value })}
                  aria-invalid={state.lineErrors[l.key] && (l.amount || l.accountId) ? 'true' : undefined}
                  aria-describedby={
                    state.lineErrors[l.key] && (l.amount || l.accountId) ? `${l.key}-err` : undefined
                  }
                />
                {state.lineErrors[l.key] && (l.amount || l.accountId) && (
                  <p id={`${l.key}-err`} className="field-error">
                    {state.lineErrors[l.key]}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="btn-secondary"
                aria-label={`Remove line ${i + 1}`}
                disabled={lines.length <= 1}
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>
          Add line
        </button>
        <p className="text-sm" aria-live="polite" data-testid="split-remaining">
          {state.remaining === null
            ? 'Enter the transaction amount first.'
            : state.remaining === 0n
              ? 'Fully allocated.'
              : state.remaining > 0n
                ? `${formatMinor(state.remaining, currency)} left to allocate`
                : `${formatMinor(-state.remaining, currency)} over the total`}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!state.balanced}>
            Save split
          </button>
        </div>
      </form>
    </dialog>
  );
}
