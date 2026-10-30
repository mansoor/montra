'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { AiEventDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { formatUsd, OUTCOME_TONE } from '@/lib/ai';
import { percent } from '@/lib/review';
import { useI18n } from '../i18n';

const PAGE = 50;

/**
 * AI activity log (AIA-10): every AI call with its input hash (never the input), model, outcome, confidence and
 * cost. Members can expand an entry to see the output, delete one entry, or delete them all.
 */
export function AiActivity({ workspaceId }: { workspaceId: string }) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<AiEventDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      try {
        const page = await browserApi.listAiEvents(workspaceId, { cursor: after ?? undefined, limit: PAGE });
        setEvents((prev) => (after ? [...prev, ...page.data] : page.data));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(friendlyMessage(err, t));
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, t],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function remove(id: string) {
    setError(null);
    try {
      await browserApi.deleteAiEvent(workspaceId, id);
      setEvents((list) => list.filter((e) => e.id !== id));
      setNotice(t('ai.activity.deleted_one'));
    } catch (err) {
      setError(friendlyMessage(err, t));
    }
  }

  async function removeAll() {
    if (!window.confirm(t('ai.activity.confirm_delete_all'))) return;
    setError(null);
    try {
      await browserApi.deleteAllAiEvents(workspaceId);
      setEvents([]);
      setCursor(null);
      setNotice(t('ai.activity.deleted_all'));
    } catch (err) {
      setError(friendlyMessage(err, t));
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="ai-activity-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="ai-activity-title" className="text-lg font-semibold">
            {t('ai.activity.title')}
          </h2>
          <p className="text-sm text-muted">{t('ai.activity.intro')}</p>
        </div>
        <button
          type="button"
          className="btn-secondary text-bad"
          disabled={events.length === 0}
          onClick={removeAll}
        >
          {t('ai.activity.delete_all')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <p role="status" className="text-sm text-good">
        {notice}
      </p>
      {events.length === 0 && !loading ? (
        <p className="card text-sm text-muted">{t('ai.activity.empty')}</p>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">{t('ai.activity.time')}</th>
                <th className="px-3 py-2">{t('ai.activity.task')}</th>
                <th className="px-3 py-2">{t('ai.activity.model')}</th>
                <th className="px-3 py-2">{t('ai.activity.outcome')}</th>
                <th className="px-3 py-2 text-right">{t('ai.activity.items')}</th>
                <th className="px-3 py-2 text-right">{t('ai.activity.confidence')}</th>
                <th className="px-3 py-2 text-right">{t('ai.activity.cost')}</th>
                <th className="px-3 py-2">
                  <span className="sr-only">{t('ai.activity.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.map((e) => (
                <Fragment key={e.id}>
                  <tr data-testid="ai-event-row">
                    <td className="whitespace-nowrap px-3 py-2">
                      {new Date(e.createdAt).toLocaleString(locale)}
                    </td>
                    <td className="px-3 py-2">{e.task}</td>
                    <td className="px-3 py-2 text-xs">
                      {e.model}
                      <span className="block text-muted">{e.provider}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`chip chip-${OUTCOME_TONE[e.outcome]}`}>
                        {t(`ai.outcome.${e.outcome}`)}
                      </span>
                    </td>
                    <td className="num px-3 py-2 text-right">{e.items}</td>
                    <td className="num px-3 py-2 text-right">
                      {e.confidence === null ? '—' : `${percent(e.confidence)}%`}
                    </td>
                    <td className="num px-3 py-2 text-right">{formatUsd(e.costUsd, locale)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1"
                        aria-expanded={open === e.id}
                        onClick={() => setOpen(open === e.id ? null : e.id)}
                      >
                        {open === e.id ? t('ai.activity.hide') : t('ai.activity.details')}
                      </button>{' '}
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-bad"
                        aria-label={t('ai.activity.delete_one', { task: e.task })}
                        onClick={() => void remove(e.id)}
                      >
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                  {open === e.id && (
                    <tr>
                      <td colSpan={8} className="bg-canvas px-3 py-2">
                        <dl className="grid gap-1 text-xs sm:grid-cols-[10rem_1fr]">
                          <dt className="text-muted">{t('ai.activity.input_hash')}</dt>
                          <dd className="break-all font-mono">{e.inputHash}</dd>
                          <dt className="text-muted">{t('ai.activity.prompt_version')}</dt>
                          <dd>{e.promptVersion}</dd>
                          <dt className="text-muted">{t('ai.activity.latency')}</dt>
                          <dd>{e.latencyMs === null ? '—' : `${e.latencyMs} ms`}</dd>
                          <dt className="text-muted">{t('ai.activity.tokens')}</dt>
                          <dd>
                            {e.tokensIn ?? '—'} / {e.tokensOut ?? '—'}
                          </dd>
                          {e.userAction && (
                            <>
                              <dt className="text-muted">{t('ai.activity.user_action')}</dt>
                              <dd>{e.userAction}</dd>
                            </>
                          )}
                        </dl>
                        <pre className="mt-2 max-h-64 overflow-auto rounded border border-line bg-surface p-2 text-xs">
                          {JSON.stringify(e.output, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button type="button" className="btn-secondary" disabled={loading} onClick={() => void load(cursor)}>
          {t('ai.activity.load_more')}
        </button>
      )}
      {loading && (
        <p role="status" className="text-xs text-muted">
          {t('common.loading')}
        </p>
      )}
    </section>
  );
}
