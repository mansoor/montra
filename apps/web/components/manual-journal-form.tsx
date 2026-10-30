'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { AccountDto, CategoryDto, JournalEntryDetailDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { evaluateJournal, toJournalLines, type JournalLine } from '@/lib/journal';
import { formatMinor } from '@/lib/money';
import { FormError } from './field';
import { JournalView } from './journal-view';

let counter = 0;
const line = (): JournalLine => ({ key: `jl-${++counter}`, accountId: '', debit: '', credit: '' });

/** Manual journal entry (DE-07). Save stays disabled until debits equal credits. */
export function ManualJournalForm({
  workspace,
  accounts,
  categories,
  today,
}: {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  categories: CategoryDto[];
  today: string;
}) {
  const [entityId, setEntityId] = useState(workspace.entities[0]?.id ?? '');
  const [lines, setLines] = useState<JournalLine[]>(() => [line(), line()]);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<JournalEntryDetailDto | null>(null);
  const entity = workspace.entities.find((e) => e.id === entityId);
  const currency = entity?.functionalCurrency ?? workspace.baseCurrency;
  const state = evaluateJournal(lines, currency);
  const options = useMemo(
    () => ({
      accounts: accounts.filter((a) => a.entityId === entityId && a.currency === currency),
      income: categories.filter((c) => c.entityId === entityId && c.type === 'income'),
      expense: categories.filter((c) => c.entityId === entityId && c.type === 'expense'),
    }),
    [accounts, categories, entityId, currency],
  );
  const update = (key: string, patch: Partial<JournalLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!state.balanced) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErrors({ fields: {} });
    try {
      const entry = await browserApi.createJournalEntry(workspace.id, {
        entityId,
        date: String(f.get('date')),
        description: String(f.get('description') ?? '').trim(),
        kind: String(f.get('kind')) as 'manual' | 'adjustment' | 'depreciation',
        lines: toJournalLines(lines, currency),
      });
      setCreated(entry);
      setLines([line(), line()]);
    } catch (err) {
      setErrors(toFormErrors(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="card space-y-4" aria-label="Journal entry" noValidate>
        <FormError message={errors.form} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="mj-entity" className="field-label">
              Books
            </label>
            <select
              id="mj-entity"
              className="input"
              value={entityId}
              onChange={(e) => {
                setEntityId(e.target.value);
                setLines([line(), line()]);
              }}
            >
              {workspace.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mj-date" className="field-label">
              Date
            </label>
            <input id="mj-date" name="date" type="date" className="input" defaultValue={today} />
          </div>
          <div>
            <label htmlFor="mj-kind" className="field-label">
              Kind
            </label>
            <select id="mj-kind" name="kind" className="input" defaultValue="manual">
              <option value="manual">Manual</option>
              <option value="adjustment">Adjustment</option>
              <option value="depreciation">Depreciation</option>
            </select>
          </div>
          <div>
            <label htmlFor="mj-desc" className="field-label">
              Description
            </label>
            <input
              id="mj-desc"
              name="description"
              className="input"
              required
              maxLength={500}
              aria-invalid={errors.fields.description ? 'true' : undefined}
            />
            {errors.fields.description && <p className="field-error">{errors.fields.description}</p>}
          </div>
        </div>

        <table className="w-full text-sm">
          <caption className="sr-only">Journal lines</caption>
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="py-1">
                Account
              </th>
              <th scope="col" className="w-32 py-1 text-right">
                Debit
              </th>
              <th scope="col" className="w-32 py-1 text-right">
                Credit
              </th>
              <th scope="col" className="w-12 py-1">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key} className="align-top">
                <td className="py-1 pr-2">
                  <label htmlFor={`${l.key}-acc`} className="sr-only">
                    Account for line {i + 1}
                  </label>
                  <select
                    id={`${l.key}-acc`}
                    className="input"
                    value={l.accountId}
                    onChange={(e) => update(l.key, { accountId: e.target.value })}
                  >
                    <option value="">Choose account…</option>
                    <optgroup label="Bank, card and asset accounts">
                      {options.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Income categories">
                      {options.income.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Expense categories">
                      {options.expense.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  {state.lineErrors[l.key] && (l.debit || l.credit || l.accountId) && (
                    <p className="field-error">{state.lineErrors[l.key]}</p>
                  )}
                </td>
                <td className="py-1 pr-2">
                  <label htmlFor={`${l.key}-dr`} className="sr-only">
                    Debit for line {i + 1}
                  </label>
                  <input
                    id={`${l.key}-dr`}
                    className="input num text-right"
                    inputMode="decimal"
                    value={l.debit}
                    onChange={(e) => update(l.key, { debit: e.target.value })}
                  />
                </td>
                <td className="py-1 pr-2">
                  <label htmlFor={`${l.key}-cr`} className="sr-only">
                    Credit for line {i + 1}
                  </label>
                  <input
                    id={`${l.key}-cr`}
                    className="input num text-right"
                    inputMode="decimal"
                    value={l.credit}
                    onChange={(e) => update(l.key, { credit: e.target.value })}
                  />
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={lines.length <= 2}
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="font-medium">
            <tr>
              <th scope="row" className="py-2 text-left">
                Totals
              </th>
              <td className="py-2 pr-2 text-right num">{formatMinor(state.totalDebit, currency)}</td>
              <td className="py-2 pr-2 text-right num">{formatMinor(state.totalCredit, currency)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary" onClick={() => setLines((ls) => [...ls, line()])}>
            Add line
          </button>
          <p aria-live="polite" className={`text-sm ${state.difference === 0n ? 'text-good' : 'text-bad'}`}>
            {state.difference === 0n
              ? state.totalDebit > 0n
                ? 'Balanced.'
                : 'Enter amounts.'
              : `Out of balance by ${formatMinor(state.difference < 0n ? -state.difference : state.difference, currency)}`}
          </p>
          <button type="submit" className="btn-primary ml-auto" disabled={busy || !state.balanced}>
            {busy ? 'Posting…' : 'Post entry'}
          </button>
        </div>
      </form>
      {created && (
        <section aria-label="Posted entry" className="space-y-2">
          <p role="status" className="text-sm text-good">
            Posted.
          </p>
          <JournalView entry={created} entityName={entity?.name ?? ''} />
        </section>
      )}
    </div>
  );
}
