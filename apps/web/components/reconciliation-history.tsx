'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { ReconciliationHistoryDto, ReconciliationHistoryItemDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { Field, FormError } from './field';
import { DateText, useI18n } from './i18n';
import { Money } from './money';

/**
 * An account's reconciliation history (DE-14): each statement with its ending balance, who finished it and when, any
 * adjustment, and Undo on the latest completed one for owners and accountants (DE-13), which asks for a reason.
 */
export function ReconciliationHistory({
  workspaceId,
  history,
}: {
  workspaceId: string;
  history: ReconciliationHistoryDto;
}) {
  const { t } = useI18n();
  const base = `/w/${workspaceId}/accounts/${history.accountId}/reconcile`;
  if (history.items.length === 0)
    return (
      <p className="card text-sm text-muted" role="status">
        {t('reconcile.history.empty')}
      </p>
    );
  return (
    <div className="card overflow-x-auto p-0">
      <table className="tbl min-w-[40rem] text-sm">
        <caption className="sr-only">{t('reconcile.history.title')}</caption>
        <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-2">
              {t('reconcile.statement_date')}
            </th>
            <th scope="col" className="px-4 py-2 text-right">
              {t('reconcile.ending')}
            </th>
            <th scope="col" className="px-4 py-2">
              {t('reconcile.history.status')}
            </th>
            <th scope="col" className="px-4 py-2">
              {t('reconcile.history.adjustment')}
            </th>
            <th scope="col" className="px-4 py-2">
              <span className="sr-only">{t('reconcile.history.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {history.items.map((item) => (
            <HistoryRow key={item.id} workspaceId={workspaceId} base={base} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({
  workspaceId,
  base,
  item,
}: {
  workspaceId: string;
  base: string;
  item: ReconciliationHistoryItemDto;
}) {
  const { t, date } = useI18n();
  const day = (iso: string | null) => (iso ? date(iso.slice(0, 10)) : '—');
  const [undoing, setUndoing] = useState(false);
  return (
    <>
      <tr data-testid="reconciliation-row" data-status={item.status}>
        <td className="whitespace-nowrap px-4 py-2">
          <DateText date={item.statementDate} />
        </td>
        <td className="px-4 py-2 text-right">
          <Money amount={item.statementBalance.amount} currency={item.statementBalance.currency} />
        </td>
        <td className="px-4 py-2">
          {item.status === 'completed' && (
            <span>
              {t('reconcile.history.completed_by', {
                name: item.completedBy?.name || '—',
                when: day(item.completedAt),
              })}
            </span>
          )}
          {item.status === 'in_progress' && (
            <Link className="font-medium underline" href={`${base}?r=${item.id}`}>
              {t('reconcile.history.in_progress')}
            </Link>
          )}
          {item.status === 'undone' && (
            <span className="text-muted">
              {t('reconcile.history.undone_by', {
                name: item.undoneBy?.name || '—',
                when: day(item.undoneAt),
              })}
              {item.undoReason ? (
                <span className="block text-xs" data-testid="undo-reason">
                  {t('reconcile.history.reason', { reason: item.undoReason })}
                </span>
              ) : null}
            </span>
          )}
        </td>
        <td className="px-4 py-2">
          {item.adjustment ? (
            <Link
              className="text-bad hover:underline"
              href={`/w/${workspaceId}/transactions/${item.adjustment.transactionId}`}
              data-testid="history-adjustment"
            >
              <span aria-hidden="true">⚠ </span>
              {t('reconcile.history.adjusted')}{' '}
              <Money amount={item.adjustment.amount.amount} currency={item.adjustment.amount.currency} />
            </Link>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="px-4 py-2 text-right">
          {item.canUndo && !undoing && (
            <button type="button" className="btn-secondary" onClick={() => setUndoing(true)}>
              {t('reconcile.undo')}
            </button>
          )}
        </td>
      </tr>
      {undoing && (
        <tr>
          <td colSpan={5} className="px-4 py-3">
            <UndoForm workspaceId={workspaceId} item={item} onCancel={() => setUndoing(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

function UndoForm({
  workspaceId,
  item,
  onCancel,
}: {
  workspaceId: string;
  item: ReconciliationHistoryItemDto;
  onCancel: () => void;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (reason.length < 3) return setErrors({ fields: { reason: t('reconcile.undo_reason_required') } });
    setBusy(true);
    setErrors({ fields: {} });
    try {
      await browserApi.undoReconciliation(workspaceId, item.id, { reason });
      onCancel();
      router.refresh();
    } catch (err) {
      setErrors(toFormErrors(err, {}, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-lg space-y-3" noValidate data-testid="undo-form">
      <p className="text-sm">{t('reconcile.undo_intro')}</p>
      <Field id="reason" label={t('reconcile.undo_reason')} error={errors.fields.reason}>
        {(p) => <textarea {...p} name="reason" rows={2} maxLength={500} className="input" required />}
      </Field>
      <FormError message={errors.form} action={errors.action} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('reconcile.undo_confirm')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {t('reconcile.adjust_cancel')}
        </button>
      </div>
    </form>
  );
}
