'use client';

import type { TrashItemDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { DateText } from './i18n';
import { Money } from './money';
import { StatusLine, useAction } from './use-action';

/** BAK-06: what's been deleted, and until when it can come back. */
export function TrashList({ workspaceId, items }: { workspaceId: string; items: TrashItemDto[] }) {
  const { run, busy, message, t } = useAction();
  if (items.length === 0) return <p className="card text-sm text-muted">{t('trash.empty')}</p>;
  return (
    <section className="card-flush" aria-label={t('trash.title')}>
      <ul className="divide-y divide-line">
        {items.map((i) => (
          <li
            key={i.id}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            data-testid="trash-row"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {i.title}
                {i.amount && i.currency && (
                  <>
                    {' · '}
                    <Money amount={i.amount} currency={i.currency} />
                  </>
                )}
              </p>
              <p className="text-xs text-muted">
                {t(`trash.kind_${i.kind}`)} · {t('trash.until')} <DateText date={i.purgeOn} />
              </p>
            </div>
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
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3">
        <StatusLine message={message} />
      </div>
    </section>
  );
}
