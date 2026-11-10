'use client';

import { useState } from 'react';
import type { CategoryDto, PlanningSettingsDto } from '@montra/api-client';
import { abs, asCurrencyCode, minorUnits, parseMoney } from '@montra/domain';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/**
 * Inputs to the recommendation rules (REC-01, REC-03): which spending categories to protect when the plan is
 * over income, the APR from which a debt counts as high-interest, and the amount from which everyday purchases are
 * worth a receipt (UP-09).
 */
export function PlanningSettings({
  workspaceId,
  initial,
  categories,
  currency,
}: {
  workspaceId: string;
  initial: PlanningSettingsDto;
  categories: CategoryDto[];
  /** The base currency: the receipt reminder amount is in it. */
  currency: string;
}) {
  const { t } = useI18n();
  const exp = minorUnits(asCurrencyCode(currency));
  const [reminder, setReminder] = useState(
    initial.receiptReminderMinor === null
      ? ''
      : (Number(initial.receiptReminderMinor) / 10 ** exp).toFixed(exp),
  );
  const { run, busy, message } = useAction();
  const [apr, setApr] = useState((initial.highInterestBps / 100).toFixed(2));
  const [priorities, setPriorities] = useState<Record<string, number>>(initial.categoryPriorities);
  const spending = categories.filter((c) => c.type === 'expense' && c.group);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const bps = Math.trunc(Number(apr.replace(',', '.')) * 100);
        let receiptReminderMinor: string | null = initial.receiptReminderMinor;
        try {
          receiptReminderMinor = reminder.trim()
            ? String(abs(parseMoney(reminder.replace(',', '.'), currency).amount))
            : null;
        } catch {
          // Not a number: keep what was saved.
        }
        void run(
          () =>
            browserApi.updatePlanningSettings(workspaceId, {
              highInterestBps: Number.isFinite(bps)
                ? Math.max(0, Math.min(10_000, bps))
                : initial.highInterestBps,
              categoryPriorities: priorities,
              receiptReminderMinor,
            }),
          t('common.saved'),
        );
      }}
    >
      <section className="card max-w-xl space-y-2">
        <h2 className="text-base font-semibold">{t('planning.high_interest')}</h2>
        <p className="text-sm text-muted">{t('planning.high_interest_hint')}</p>
        <label className="flex items-center gap-2">
          <input
            className="input num w-24"
            inputMode="decimal"
            value={apr}
            onChange={(e) => setApr(e.target.value)}
          />
          <span className="text-sm">%</span>
        </label>
      </section>
      <section className="card max-w-xl space-y-2">
        <h2 className="text-base font-semibold">{t('planning.receipt_reminder')}</h2>
        <p className="text-sm text-muted">{t('planning.receipt_reminder_hint')}</p>
        <label className="flex items-center gap-2">
          <input
            className="input num w-28"
            inputMode="decimal"
            aria-label={t('planning.receipt_reminder')}
            value={reminder}
            onChange={(e) => setReminder(e.target.value)}
            data-testid="receipt-reminder"
          />
          <span className="text-sm">{currency}</span>
        </label>
      </section>
      <section className="card-flush">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{t('planning.priorities')}</h2>
          <p className="text-sm text-muted">{t('planning.priorities_hint')}</p>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col" className="px-4 py-2">
                {t('budget.category')}
              </th>
              <th scope="col" className="px-4 py-2">
                {t('planning.priority')}
              </th>
            </tr>
          </thead>
          <tbody>
            {spending.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-1.5">
                  {c.name} <span className="text-xs text-muted">· {c.group}</span>
                </td>
                <td className="px-4 py-1.5">
                  <select
                    className="input w-auto"
                    aria-label={t('planning.priority_for', { name: c.name })}
                    value={priorities[c.id] ?? ''}
                    onChange={(e) => {
                      const next = { ...priorities };
                      if (e.target.value) next[c.id] = Number(e.target.value);
                      else delete next[c.id];
                      setPriorities(next);
                    }}
                  >
                    <option value="">{t('planning.priority_default')}</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {t(`planning.priority_${n}`)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <button type="submit" className="btn-primary" disabled={busy}>
        {t('common.save')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
