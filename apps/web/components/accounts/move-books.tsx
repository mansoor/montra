'use client';

import { useState } from 'react';
import type { AccountDto, AccountMovePreviewDto, WorkspaceDto } from '@montra/api-client';

type EntityDto = WorkspaceDto['entities'][number];
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/**
 * Moving the account to other books (ADR-0033): pick the books, see what would move and what stops it, then move. Its
 * whole history moves with it; amounts, dates and reconciled lines stay as they are.
 */
export function MoveBooks({
  workspaceId,
  account,
  entities,
}: {
  workspaceId: string;
  account: AccountDto;
  /** Books it could go to: Personal and the businesses, not the one it's in. */
  entities: readonly EntityDto[];
}) {
  const { t } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const [to, setTo] = useState(entities[0]?.id ?? '');
  const [preview, setPreview] = useState<AccountMovePreviewDto | null>(null);
  const name = (id: string) => entities.find((e) => e.id === id)?.name ?? '';
  if (entities.length === 0) return null;

  async function check(entityId: string) {
    setPreview(null);
    setMessage(null);
    try {
      setPreview(await browserApi.previewAccountMove(workspaceId, account.id, entityId));
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    }
  }

  return (
    <section className="card space-y-3" aria-labelledby="move-books-title" data-testid="move-books">
      <div>
        <h2 id="move-books-title" className="text-base font-semibold">
          {t('account.move.title')}
        </h2>
        <p className="text-sm text-muted">{t('account.move.hint')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label>
          <span className="field-label">{t('account.move.to')}</span>
          <select
            className="input"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPreview(null);
            }}
          >
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-secondary" disabled={busy || !to} onClick={() => void check(to)}>
          {t('account.move.check')}
        </button>
      </div>
      {preview && !preview.moved && (
        <div className="space-y-2 text-sm" data-testid="move-preview" aria-live="polite">
          <p>
            {t('account.move.summary', {
              transactions: preview.transactions,
              entries: preview.entries,
              books: name(preview.toEntityId),
            })}
          </p>
          {preview.reconciledLines > 0 && (
            <p className="text-muted">{t('account.move.reconciled', { count: preview.reconciledLines })}</p>
          )}
          {preview.crossBooks > 0 && (
            <p className="text-muted">{t('account.move.cross_books', { count: preview.crossBooks })}</p>
          )}
          {preview.clearedDefaults.map((d) => (
            <p key={d} className="text-muted">
              {t(`account.move.cleared.${d}`)}
            </p>
          ))}
          {preview.blockers.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-bad" data-testid="move-blockers">
              {preview.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    await browserApi.moveAccount(workspaceId, account.id, preview.toEntityId);
                    setPreview(null);
                  },
                  t('account.move.done', { books: name(preview.toEntityId) }),
                )
              }
            >
              {t('account.move.confirm', { books: name(preview.toEntityId) })}
            </button>
          )}
        </div>
      )}
      <StatusLine message={message} />
    </section>
  );
}
