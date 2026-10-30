'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { AccountDto, ReconciliationDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage, toFormErrors, type FormErrors } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { Field, FormError } from './field';
import { DateText, useI18n } from './i18n';
import { Money } from './money';

/**
 * Statement reconciliation (DE-08): enter the statement's date and ending balance, tick the lines that appear
 * on it, and complete once the cleared balance equals the statement. Completed lines are locked.
 */
export function Reconciler({
  workspaceId,
  account,
  initial,
  today,
}: {
  workspaceId: string;
  account: AccountDto;
  initial: ReconciliationDto | null;
  today: string;
}) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [rec, setRec] = useState(initial);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/w/${workspaceId}/accounts/${account.id}/reconcile`;

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = parseAmountInput(String(f.get('statementBalance') ?? ''), account.currency, locale, t);
    if (!parsed.ok) return setErrors({ fields: { statementBalance: parsed.error } });
    setBusy(true);
    setErrors({ fields: {} });
    try {
      const r = await browserApi.startReconciliation(workspaceId, account.id, {
        statementDate: String(f.get('statementDate') || today),
        statementBalance: { amount: parsed.minor.toString(), currency: account.currency },
      });
      setRec(r);
      router.replace(`${base}?r=${r.id}`);
    } catch (err) {
      setErrors(toFormErrors(err, { 'statementBalance.amount': 'statementBalance' }, t));
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<ReconciliationDto>) {
    const before = rec;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setRec(r);
      if (r.status === 'completed') router.refresh();
    } catch (err) {
      setRec(before);
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!rec)
    return (
      <form onSubmit={start} className="card max-w-lg space-y-4" noValidate>
        <p className="text-sm text-muted">{t('reconcile.intro')}</p>
        <Field id="statementDate" label={t('reconcile.statement_date')} error={errors.fields.statementDate}>
          {(p) => (
            <input {...p} name="statementDate" type="date" defaultValue={today} className="input" required />
          )}
        </Field>
        <Field
          id="statementBalance"
          label={t('reconcile.statement_balance', { currency: account.currency })}
          error={errors.fields.statementBalance}
          hint={account.type === 'liability' ? t('reconcile.balance_hint_owed') : undefined}
        >
          {(p) => <input {...p} name="statementBalance" inputMode="decimal" className="input" required />}
        </Field>
        <FormError message={errors.form} action={errors.action} />
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('reconcile.start')}
        </button>
      </form>
    );

  const completed = rec.status === 'completed';
  const balanced = rec.difference.amount === '0';
  const open = rec.lines.filter((l) => l.cleared === 'uncleared').map((l) => l.postingId);

  return (
    <div className="space-y-4">
      <dl className="grid gap-3 sm:grid-cols-4" data-testid="reconcile-totals">
        <div className="card">
          <dt className="text-xs uppercase tracking-wide text-muted">{t('reconcile.statement_on')}</dt>
          <dd className="font-semibold">
            <DateText date={rec.statementDate} />
          </dd>
        </div>
        <div className="card">
          <dt className="text-xs uppercase tracking-wide text-muted">{t('reconcile.statement')}</dt>
          <dd className="font-semibold">
            <Money amount={rec.statementBalance.amount} currency={rec.statementBalance.currency} />
          </dd>
        </div>
        <div className="card">
          <dt className="text-xs uppercase tracking-wide text-muted">{t('reconcile.cleared')}</dt>
          <dd className="font-semibold" data-testid="cleared-balance">
            <Money amount={rec.clearedBalance.amount} currency={rec.clearedBalance.currency} />
          </dd>
        </div>
        <div className="card">
          <dt className="text-xs uppercase tracking-wide text-muted">{t('reconcile.difference')}</dt>
          <dd
            className={`font-semibold ${balanced ? 'text-good' : 'text-bad'}`}
            data-testid="reconcile-difference"
            aria-live="polite"
          >
            <Money amount={rec.difference.amount} currency={rec.difference.currency} />
          </dd>
        </div>
      </dl>

      {completed ? (
        <p role="status" className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">
          {t('reconcile.completed')}{' '}
          <Link className="font-medium underline" href={`/w/${workspaceId}/accounts/${account.id}`}>
            {t('reconcile.back')}
          </Link>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !balanced}
            onClick={() => run(() => browserApi.completeReconciliation(workspaceId, rec.id))}
          >
            {t('reconcile.complete')}
          </button>
          {open.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => run(() => browserApi.setCleared(workspaceId, rec.id, { clear: open }))}
            >
              {t('reconcile.clear_all')}
            </button>
          )}
          {!balanced && <span className="text-sm text-muted">{t('reconcile.complete_hint')}</span>}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}

      {rec.lines.length === 0 ? (
        <p className="card text-sm text-muted">{t('reconcile.no_lines')}</p>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">{t('reconcile.lines')}</caption>
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="w-12 px-4 py-2">
                  <span className="sr-only">{t('reconcile.cleared')}</span>
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('fields.date')}
                </th>
                <th scope="col" className="px-4 py-2">
                  {t('fields.description')}
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  {t('fields.amount')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rec.lines.map((l) => {
                const locked = l.cleared === 'reconciled';
                return (
                  <tr key={l.postingId} data-testid="reconcile-line" data-cleared={l.cleared}>
                    <td className="px-4 py-2">
                      {locked ? (
                        <span
                          role="img"
                          aria-label={t('register.reconciled')}
                          title={t('register.reconciled')}
                        >
                          🔒
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={t('reconcile.toggle', { description: l.description || '—' })}
                          checked={l.cleared === 'cleared'}
                          disabled={busy || completed}
                          onChange={(e) => {
                            const clear = e.target.checked;
                            // Show the tick at once; totals come back from the server.
                            setRec({
                              ...rec,
                              lines: rec.lines.map((x) =>
                                x.postingId === l.postingId
                                  ? { ...x, cleared: clear ? 'cleared' : 'uncleared' }
                                  : x,
                              ),
                            });
                            void run(() =>
                              browserApi.setCleared(
                                workspaceId,
                                rec.id,
                                clear ? { clear: [l.postingId] } : { unclear: [l.postingId] },
                              ),
                            );
                          }}
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <DateText date={l.date} />
                    </td>
                    <td className="px-4 py-2">
                      {l.transactionId ? (
                        <Link
                          className="hover:underline"
                          href={`/w/${workspaceId}/transactions/${l.transactionId}`}
                        >
                          {l.description || '—'}
                        </Link>
                      ) : (
                        l.description || '—'
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Money amount={l.amount} currency={account.currency} signed />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
