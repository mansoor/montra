'use client';

import Link from 'next/link';
import type { ReceiptRecommendationDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/** RCP-11: big purchases at multi-department stores are worth a receipt; split them by item. */
export function ReceiptRecommendations({
  workspaceId,
  items,
}: {
  workspaceId: string;
  items: ReceiptRecommendationDto[];
}) {
  const { run, busy, message, t } = useAction();
  if (items.length === 0) return null;
  return (
    <section className="card space-y-2" aria-labelledby="recommended-title">
      <h2 id="recommended-title" className="font-medium">
        {t('receipts.recommended_title')}
      </h2>
      <p className="text-sm text-muted">{t('receipts.recommended_intro')}</p>
      <ul className="divide-y divide-line">
        {items.map((r) => (
          <li key={r.transactionId} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <DateText date={r.date} />
            <span className="font-medium">{r.merchant}</span>
            <Money amount={r.amount.amount} currency={r.amount.currency} />
            <span className="ml-auto flex gap-2">
              <Link
                href={`/w/${workspaceId}/transactions/${r.transactionId}#receipt`}
                className="btn-secondary"
              >
                {t('receipts.add_receipt')}
              </Link>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  run(
                    () => browserApi.dismissReceiptRecommendation(workspaceId, r.transactionId),
                    t('receipts.dismissed'),
                  )
                }
              >
                {t('receipts.dismiss')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <StatusLine message={message} />
    </section>
  );
}
