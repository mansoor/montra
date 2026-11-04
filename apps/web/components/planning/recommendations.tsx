'use client';

import { RefreshCw, Sparkles } from 'lucide-react';
import type { RecommendationDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/**
 * Recommendations (REC-01..08): the computed title and figures always show; the AI wording, when present,
 * only restates them. Proposed changes are listed before anything is applied (nothing applies on its own).
 */
export function RecommendationList({
  workspaceId,
  items,
  categoryNames,
  compact = false,
}: {
  workspaceId: string;
  items: RecommendationDto[];
  categoryNames: Record<string, string>;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { run, busy, message } = useAction();
  const name = (id: string | null) =>
    id ? (categoryNames[id] ?? t('rec.a_category')) : t('budget.lta_label');
  return (
    <div className="space-y-3">
      {items.map((r) => (
        <article key={r.id} className="card space-y-2" aria-labelledby={`rec-${r.id}`}>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600">
              <Sparkles aria-hidden size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id={`rec-${r.id}`} className="font-semibold">
                {r.title}
              </h3>
              {r.wording && <p className="mt-1 text-sm whitespace-pre-line text-ink-soft">{r.wording}</p>}
            </div>
            <span className="chip chip-muted">{t(`rec.type_${r.type}`)}</span>
          </div>
          {!compact && r.payload.actions.length > 0 && (
            <ul className="ml-11 list-disc space-y-0.5 pl-4 text-sm text-ink-soft">
              {r.payload.actions.map((a, i) => (
                <li key={i}>
                  {a.kind === 'assign' && (
                    <>
                      {t('rec.action_assign', { name: name(a.categoryId) })}{' '}
                      <Money amount={a.from} currency={r.payload.currency} /> →{' '}
                      <Money amount={a.to} currency={r.payload.currency} />
                    </>
                  )}
                  {a.kind === 'move' && (
                    <>
                      {t('rec.action_move', { from: name(a.from), to: name(a.to) })}{' '}
                      <Money amount={a.amount} currency={r.payload.currency} />
                    </>
                  )}
                  {a.kind === 'reduce_daily' && (
                    <>
                      {t('rec.action_reduce', { name: name(a.categoryId), days: a.days })}{' '}
                      <Money amount={a.perDay} currency={r.payload.currency} />
                    </>
                  )}
                  {a.kind === 'fund_goal' && (
                    <>
                      {t('rec.action_fund')} <Money amount={a.amount} currency={r.payload.currency} />
                    </>
                  )}
                  {a.kind === 'review_subscription' && t('rec.action_review')}
                  {a.kind === 'transfer' && (
                    <>
                      {t('rec.action_transfer')} <Money amount={a.amount} currency={r.payload.currency} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!compact && r.payload.review && (
            <div className="ml-11 grid gap-2 text-sm sm:grid-cols-2">
              {r.payload.review.wentWell.length > 0 && (
                <div>
                  <div className="section-h">{t('rec.went_well')}</div>
                  <ul className="mt-1 text-ink-soft">
                    {r.payload.review.wentWell.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {r.payload.review.leaks.length > 0 && (
                <div>
                  <div className="section-h">{t('rec.leaks')}</div>
                  <ul className="mt-1 text-ink-soft">
                    {r.payload.review.leaks.map((l) => (
                      <li key={l.categoryId}>
                        {l.name} <Money amount={l.overBy} currency={r.payload.currency} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {r.status === 'open' && (
            <div className="ml-11 flex flex-wrap gap-2">
              {r.payload.actions.some(
                (a) =>
                  a.kind === 'assign' || a.kind === 'move' || a.kind === 'fund_goal' || a.kind === 'transfer',
              ) && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void run(() => browserApi.acceptRecommendation(workspaceId, r.id), t('rec.applied'))
                  }
                >
                  {t('rec.apply')}
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  void run(() => browserApi.dismissRecommendation(workspaceId, r.id), t('rec.dismissed'))
                }
              >
                {t('rec.dismiss')}
              </button>
            </div>
          )}
        </article>
      ))}
      <StatusLine message={message} />
    </div>
  );
}

export function RefreshRecommendations({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const { run, busy, message } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() =>
          void run(
            () => browserApi.refreshRecommendations(workspaceId),
            (r) => t('rec.refreshed', { count: r.created }),
          )
        }
      >
        <RefreshCw aria-hidden size={15} />
        {t('rec.refresh')}
      </button>
      <StatusLine message={message} />
    </span>
  );
}
