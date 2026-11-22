'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { RetentionReviewDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { retentionKey, retentionRefs, waitingItems } from '@/lib/retention';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/**
 * RCP-10: receipts and files past their retention date, for the workspace's owners. Nothing is deleted until an owner
 * approves exactly what is listed here (with a recent sign-in); "Keep for longer" moves the date instead.
 */
export function RetentionReview({
  workspaceId,
  review,
}: {
  workspaceId: string;
  review: RetentionReviewDto;
}) {
  const { run, busy, message, t } = useAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const waiting = waitingItems(review.items);
  const approved = review.items.length - waiting.length;

  const toggle = (key: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const extend = (only?: ReadonlySet<string>) =>
    run(
      () => browserApi.extendRetention(workspaceId, { items: retentionRefs(review.items, only) }),
      (r) => t('retention.extended', { count: r.count, years: review.extendYears }),
    ).then(() => setSelected(new Set()));

  const approve = () =>
    run(
      () => browserApi.approveRetention(workspaceId, { items: retentionRefs(review.items) }),
      (r) => t('retention.approved', { count: r.count }),
    ).then(() => setConfirming(false));

  return (
    <section id="retention" className="card space-y-3" aria-labelledby="retention-title">
      <h2 id="retention-title" className="text-base font-semibold">
        {t('retention.title')}
      </h2>
      <p className="text-sm text-muted">{t('retention.hint')}</p>
      {approved > 0 && (
        <p className="text-sm" data-testid="retention-approved">
          {t('retention.approved_waiting', { count: approved })}
        </p>
      )}
      {waiting.length === 0 ? (
        <p className="text-sm text-muted">{t('retention.empty')}</p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {waiting.map((i) => {
              const key = retentionKey(i);
              return (
                <li key={key} className="flex items-start gap-3 py-2" data-testid="retention-row">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(key)}
                    aria-label={t('retention.select_named', { name: i.title })}
                    onChange={(e) => toggle(key, e.target.checked)}
                  />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {i.title}
                      {i.amount && i.currency && (
                        <>
                          {' · '}
                          <Money amount={i.amount} currency={i.currency} />
                        </>
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      {i.kind === 'receipt' ? t('retention.kind_receipt') : t('retention.kind_file')}
                      {i.date && (
                        <>
                          {' · '}
                          <DateText date={i.date} />
                        </>
                      )}
                      {' · '}
                      {t('retention.kept_until')} <DateText date={i.retainUntil} />
                    </p>
                    {i.transaction && (
                      <p className="text-xs text-muted">
                        {t('retention.transaction_stays')}{' '}
                        <Link
                          className="underline"
                          href={`/w/${workspaceId}/transactions/${i.transaction.id}`}
                        >
                          {i.transaction.payee ?? t('retention.transaction')}
                        </Link>{' '}
                        · <DateText date={i.transaction.date} />
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => extend()}>
              {t('retention.keep_all', { years: review.extendYears })}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || selected.size === 0}
              onClick={() => extend(selected)}
            >
              {t('retention.keep_selected', { count: selected.size, years: review.extendYears })}
            </button>
            {!confirming && (
              <button
                type="button"
                className="btn-danger"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {t('retention.delete_these', { count: waiting.length })}
              </button>
            )}
          </div>
          {confirming && (
            <div
              className="space-y-2 rounded border border-line p-3"
              role="group"
              aria-label={t('retention.confirm')}
            >
              <p className="text-sm">{t('retention.confirm_text', { count: waiting.length })}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-danger" disabled={busy} onClick={() => void approve()}>
                  {t('retention.confirm_delete', { count: waiting.length })}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  {t('retention.cancel')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <StatusLine message={message} />
    </section>
  );
}
