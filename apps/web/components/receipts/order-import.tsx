'use client';

import { useRef } from 'react';
import { browserApi } from '@/lib/browser-api';
import { StatusLine, useAction } from '../use-action';

/** RCP-12: import an Amazon order-history CSV; each order becomes a receipt, matched like a paper one. */
export function OrderImport({ workspaceId }: { workspaceId: string }) {
  const { run, busy, message, t } = useAction();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="card space-y-2">
      <h2 className="font-medium">{t('receipts.orders_title')}</h2>
      <p className="text-sm text-muted">{t('receipts.orders_intro')}</p>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? t('receipts.uploading') : t('receipts.orders_pick')}
      </button>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        aria-label={t('receipts.orders_pick')}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          void run(
            () => browserApi.importOrderHistory(workspaceId, f, f.name),
            (r) =>
              t('receipts.orders_done', { created: r.created, duplicates: r.duplicates, matched: r.matched }),
          );
        }}
      />
      <StatusLine message={message} />
    </div>
  );
}
