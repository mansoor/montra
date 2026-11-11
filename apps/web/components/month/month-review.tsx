'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MonthSummaryDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';

/** The month shown, as a dropdown of this month and the eleven before. */
export function MonthPicker({
  base,
  value,
  months,
  memberId,
  label,
}: {
  base: string;
  value: string;
  months: Array<{ start: string; label: string }>;
  memberId: string | null;
  label: string;
}) {
  const router = useRouter();
  return (
    <select
      className="input w-auto font-medium"
      aria-label={label}
      value={value}
      onChange={(e) => {
        const q = new URLSearchParams({ month: e.target.value });
        if (memberId) q.set('memberId', memberId);
        router.push(`${base}?${q}`);
      }}
    >
      {months.map((m) => (
        <option key={m.start} value={m.start}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

type Line = NonNullable<MonthSummaryDto['suggestions']>['lines'][number];

/**
 * Next month's budget from the last three months: each line can be made the budget (the same confirmation as in
 * Explore spending: the month, the new amount and what it replaces).
 */
export function MonthSuggestions({
  workspaceId,
  base,
  entityId,
  memberId,
  currency,
  monthLabel,
  note,
  lines,
}: {
  workspaceId: string;
  base: string;
  entityId: string;
  memberId: string | null;
  currency: string;
  period: { start: string; end: string };
  monthLabel: string;
  note: string | null;
  lines: Line[];
}) {
  const { t, money } = useI18n();
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Record<string, string | 'error'>>({});

  const make = async (l: Line) => {
    setSaving(true);
    try {
      const r = await browserApi.setCategoryBudget(workspaceId, {
        entityId,
        memberId,
        categoryId: l.categoryId,
        assigned: l.suggested,
      });
      setDone((all) => ({
        ...all,
        [l.categoryId]:
          r.previous === null
            ? t('explore.make_budget_done_new', {
                name: l.name,
                month: monthLabel,
                amount: money(r.assigned, currency),
              })
            : t('explore.make_budget_done', {
                name: l.name,
                month: monthLabel,
                amount: money(r.assigned, currency),
                previous: money(r.previous, currency),
              }),
      }));
      setConfirming(null);
      router.refresh();
    } catch {
      setDone((all) => ({ ...all, [l.categoryId]: 'error' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="suggest-heading" className="card space-y-3" data-testid="month-suggestions">
      <div>
        <h2 id="suggest-heading" className="font-semibold">
          {t('month.suggestions', { month: monthLabel })}
        </h2>
        <p className="text-xs text-muted">{note ?? t('month.suggestions_hint')}</p>
      </div>
      <ul className="divide-y divide-line text-sm">
        {lines.map((l) => {
          const msg = done[l.categoryId];
          return (
            <li key={l.categoryId} className="space-y-2 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-40 truncate font-medium">{l.name}</span>
                <span className="text-muted">
                  {l.current === null
                    ? t('month.no_budget_now')
                    : t('month.budget_now', { amount: money(l.current, currency) })}
                </span>
                <span>→ {money(l.suggested, currency)}</span>
                {confirming !== l.categoryId && (
                  <button
                    type="button"
                    className="btn-secondary ml-auto"
                    onClick={() => setConfirming(l.categoryId)}
                  >
                    {t('explore.make_budget')}
                  </button>
                )}
              </div>
              {confirming === l.categoryId && (
                <div
                  role="group"
                  aria-label={t('explore.make_budget')}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-600 p-3"
                >
                  <p className="grow">
                    {t('explore.make_budget_confirm', {
                      name: l.name,
                      month: monthLabel,
                      amount: money(l.suggested, currency),
                    })}{' '}
                    <span className="text-muted">
                      {l.current === null
                        ? t('explore.make_budget_none')
                        : t('explore.make_budget_was', { amount: money(l.current, currency) })}
                    </span>
                  </p>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={saving}
                    onClick={() => void make(l)}
                  >
                    {t('explore.make_budget_yes')}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>
                    {t('common.cancel')}
                  </button>
                </div>
              )}
              {msg === 'error' ? (
                <p role="alert" className="text-bad">
                  {t('explore.make_budget_failed')}
                </p>
              ) : msg ? (
                <p role="status" className="text-good">
                  {msg}{' '}
                  <Link href={`${base}/budget`} className="font-medium text-brand-600 underline">
                    {t('explore.open_budget')}
                  </Link>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
