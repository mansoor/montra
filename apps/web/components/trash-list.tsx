'use client';

import type { TrashItemDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { canDeleteForever } from '@/lib/trash';
import { DateText } from './i18n';
import { Money } from './money';
import { StatusLine, useAction } from './use-action';
import { useConfirm } from './ui/confirm-dialog';

/**
 * BAK-06: what's been deleted, and how and when it goes. Everything can come back until then; a business or rental
 * receipt, a tax record, stays until its retention date (RCP-10). Owners and admins can delete for good now what would
 * go after 30 days, one item or all of them; a recent sign-in is asked for (step-up comes back as a link).
 */
export function TrashList({
  workspaceId,
  items,
  canDelete,
  showDate = false,
  showEmpty = true,
}: {
  workspaceId: string;
  items: TrashItemDto[];
  /** Owners and admins. */
  canDelete: boolean;
  /** Each item's own date (the Receipts screen's Trash). */
  showDate?: boolean;
  /** The "Empty Trash" button. */
  showEmpty?: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const { confirm, dialog } = useConfirm();
  // Restoring the last item empties the list; the confirmation stays on screen with the empty state.
  if (items.length === 0) {
    return (
      <div className="space-y-2">
        <p className="card text-sm text-muted">{t('trash.empty')}</p>
        <StatusLine message={message} />
      </div>
    );
  }
  const goes = items.filter(canDeleteForever);
  return (
    <section className="card-flush" aria-label={t('trash.title')}>
      {canDelete && showEmpty && goes.length > 0 && (
        <div className="flex justify-end px-4 pt-3">
          <button
            type="button"
            className="btn-secondary text-bad"
            disabled={busy}
            data-testid="trash-empty"
            onClick={async () => {
              const ok = await confirm({
                title: t('trash.empty_title'),
                body: <p>{t('trash.empty_confirm', { count: goes.length })}</p>,
                confirmLabel: t('trash.empty_action'),
                danger: true,
              });
              if (!ok) return;
              void run(
                () => browserApi.emptyTrash(workspaceId),
                (r) => t('trash.emptied', { deleted: r.deleted, kept: r.kept }),
              );
            }}
          >
            {t('trash.empty_action')}
          </button>
        </div>
      )}
      <ul className="divide-y divide-line">
        {items.map((i) => (
          <li
            key={i.id}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            data-testid="trash-row"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {showDate && i.date && (
                  <>
                    <DateText date={i.date} />
                    {' · '}
                  </>
                )}
                {i.title}
                {i.amount && i.currency && (
                  <>
                    {' · '}
                    <Money amount={i.amount} currency={i.currency} />
                  </>
                )}
              </p>
              <p className="text-xs text-muted">
                {t(`trash.kind_${i.kind}`)} · {t(`trash.removal.${i.removal}`)} <DateText date={i.until} />
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                aria-label={t('trash.restore_named', { name: i.title })}
                onClick={() =>
                  run(
                    () => browserApi.restoreFromTrash(workspaceId, i.kind, i.id),
                    t('trash.restored', { name: i.title }),
                  )
                }
              >
                {t('trash.restore')}
              </button>
              {canDelete && canDeleteForever(i) && (
                <button
                  type="button"
                  className="btn-secondary text-bad"
                  disabled={busy}
                  aria-label={t('trash.delete_forever_named', { name: i.title })}
                  onClick={async () => {
                    const ok = await confirm({
                      title: t('trash.delete_forever_title'),
                      body: <p>{t('trash.delete_forever_confirm', { name: i.title })}</p>,
                      confirmLabel: t('trash.delete_forever'),
                      danger: true,
                    });
                    if (!ok) return;
                    void run(
                      () => browserApi.deleteFromTrash(workspaceId, i.kind, i.id),
                      t('trash.deleted_forever', { name: i.title }),
                    );
                  }}
                >
                  {t('trash.delete_forever')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3">
        <StatusLine message={message} />
      </div>
      {dialog}
    </section>
  );
}
