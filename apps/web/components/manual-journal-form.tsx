'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { JournalEntryDetailDto, LedgerAccountDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { evaluateJournal, groupLedgerAccounts, toJournalLines, type JournalLine } from '@/lib/journal';
import { FormError } from './field';
import { JournalView } from './journal-view';
import { useI18n } from './i18n';

let counter = 0;
const line = (): JournalLine => ({ key: `jl-${++counter}`, accountId: '', debit: '', credit: '' });

/** Manual journal entry (DE-07). Save stays disabled until debits equal credits. */
export function ManualJournalForm({
  workspace,
  ledgerAccounts,
  today,
}: {
  workspace: WorkspaceDto;
  /** Full chart from /ledger-accounts, including system accounts such as opening-balance equity. */
  ledgerAccounts: LedgerAccountDto[];
  today: string;
}) {
  const { t, money, locale } = useI18n();
  const [entityId, setEntityId] = useState(workspace.entities[0]?.id ?? '');
  const [lines, setLines] = useState<JournalLine[]>(() => [line(), line()]);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<JournalEntryDetailDto | null>(null);
  const entity = workspace.entities.find((e) => e.id === entityId);
  const currency = entity?.functionalCurrency ?? workspace.baseCurrency;
  const state = evaluateJournal(lines, currency, locale, t);
  const groups = useMemo(
    () => groupLedgerAccounts(ledgerAccounts, entityId, currency),
    [ledgerAccounts, entityId, currency],
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
      setErrors(toFormErrors(err, {}, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="card space-y-4" aria-label={t('journal.form_label')} noValidate>
        <FormError message={errors.form} action={errors.action} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="mj-entity" className="field-label">
              {t('bulk.books')}
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
              {t('fields.date')}
            </label>
            <input id="mj-date" name="date" type="date" className="input" defaultValue={today} />
          </div>
          <div>
            <label htmlFor="mj-kind" className="field-label">
              {t('journal.kind_label')}
            </label>
            <select id="mj-kind" name="kind" className="input" defaultValue="manual">
              <option value="manual">{t('journal.kind.manual')}</option>
              <option value="adjustment">{t('journal.kind.adjustment')}</option>
              <option value="depreciation">{t('journal.kind.depreciation')}</option>
            </select>
          </div>
          <div>
            <label htmlFor="mj-desc" className="field-label">
              {t('fields.description')}
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
          <caption className="sr-only">{t('journal.lines')}</caption>
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="py-1">
                {t('fields.account')}
              </th>
              <th scope="col" className="w-32 py-1 text-right">
                {t('journal.debit')}
              </th>
              <th scope="col" className="w-32 py-1 text-right">
                {t('journal.credit')}
              </th>
              <th scope="col" className="w-12 py-1">
                <span className="sr-only">{t('sharing.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key} className="align-top">
                <td className="py-1 pr-2">
                  <label htmlFor={`${l.key}-acc`} className="sr-only">
                    {t('journal.account_for_line', { n: i + 1 })}
                  </label>
                  <select
                    id={`${l.key}-acc`}
                    className="input"
                    value={l.accountId}
                    onChange={(e) => update(l.key, { accountId: e.target.value })}
                  >
                    <option value="">{t('journal.choose_account')}</option>
                    {groups.map((g) => (
                      <optgroup key={g.type} label={t(`account.type_plural.${g.type}`)}>
                        {g.accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {state.lineErrors[l.key] && (l.debit || l.credit || l.accountId) && (
                    <p className="field-error">{state.lineErrors[l.key]}</p>
                  )}
                </td>
                <td className="py-1 pr-2">
                  <label htmlFor={`${l.key}-dr`} className="sr-only">
                    {t('journal.debit_for_line', { n: i + 1 })}
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
                    {t('journal.credit_for_line', { n: i + 1 })}
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
                    aria-label={t('split.remove_line', { n: i + 1 })}
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
                {t('journal.totals')}
              </th>
              <td className="py-2 pr-2 text-right num">{money(state.totalDebit, currency)}</td>
              <td className="py-2 pr-2 text-right num">{money(state.totalCredit, currency)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary" onClick={() => setLines((ls) => [...ls, line()])}>
            {t('split.add_line')}
          </button>
          <p aria-live="polite" className={`text-sm ${state.difference === 0n ? 'text-good' : 'text-bad'}`}>
            {state.difference === 0n
              ? state.totalDebit > 0n
                ? t('journal.balanced')
                : t('journal.enter_amounts')
              : t('journal.out_of_balance', {
                  amount: money(state.difference < 0n ? -state.difference : state.difference, currency),
                })}
          </p>
          <button type="submit" className="btn-primary ml-auto" disabled={busy || !state.balanced}>
            {busy ? t('journal.posting') : t('journal.post')}
          </button>
        </div>
      </form>
      {created && (
        <section aria-label="Posted entry" className="space-y-2">
          <p role="status" className="text-sm text-good">
            {t('journal.posted')}
          </p>
          <JournalView entry={created} entityName={entity?.name ?? ''} />
        </section>
      )}
    </div>
  );
}
