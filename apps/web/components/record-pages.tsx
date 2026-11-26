'use client';

import { useId } from 'react';
import { movePage, removePage } from '@/lib/record-pages';
import { useConfirm } from './ui/confirm-dialog';
import { StatusLine, useAction } from './use-action';

/**
 * A receipt's or bill's pages fixed after capture (ADR-0059 §4, VLT-15): move a page up or down, or remove one (never
 * the last: deleting the record is how that goes). Each change is saved at once. Nothing is read again, and the screen
 * says so; a record the vault had goes to it again as one new PDF.
 */
export function RecordPages({
  kind,
  fileIds,
  hrefOf,
  save,
}: {
  kind: 'receipt' | 'bill';
  fileIds: readonly string[];
  /** The page's own file, to open in a new tab. */
  hrefOf: (fileId: string) => string;
  /** Saves the pages the record keeps, in their new order. */
  save: (fileIds: string[]) => Promise<unknown>;
}) {
  const { run, busy, message, t } = useAction();
  const { confirm, dialog } = useConfirm();
  const titleId = useId();
  const change = (next: string[] | null) => {
    if (next) void run(() => save(next), t('record_pages.saved'));
  };

  async function remove(i: number) {
    const next = removePage(fileIds, i);
    if (!next) return;
    const ok = await confirm({
      title: t('record_pages.remove_title', { n: i + 1 }),
      body: t('record_pages.remove_body'),
      confirmLabel: t('record_pages.remove_confirm'),
      danger: true,
    });
    if (ok) change(next);
  }

  return (
    <section aria-labelledby={titleId} className="space-y-2" data-testid="record-pages">
      <h3 id={titleId} className="text-sm font-semibold">
        {t('record_pages.title')}
      </h3>
      <p className="text-xs text-muted">
        {t(kind === 'receipt' ? 'record_pages.hint_receipt' : 'record_pages.hint_bill')}{' '}
        {t('record_pages.vault_note')}
      </p>
      <ol className="space-y-1">
        {fileIds.map((id, i) => (
          <li key={id} className="flex flex-wrap items-center gap-2 text-sm">
            <a
              href={hrefOf(id)}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-brand-600 underline"
              aria-label={t('record_pages.open', { n: i + 1 })}
            >
              {t('record_pages.page_n', { n: i + 1 })}
            </a>
            <span className="ml-auto flex gap-1">
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                disabled={busy || i === 0}
                aria-label={t('record_pages.move_up', { n: i + 1 })}
                onClick={() => change(movePage(fileIds, i, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                disabled={busy || i === fileIds.length - 1}
                aria-label={t('record_pages.move_down', { n: i + 1 })}
                onClick={() => change(movePage(fileIds, i, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs text-bad"
                disabled={busy || fileIds.length <= 1}
                aria-label={t('record_pages.remove', { n: i + 1 })}
                onClick={() => void remove(i)}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ol>
      <StatusLine message={message} />
      {dialog}
    </section>
  );
}
