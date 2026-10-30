'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CategoryDto, WorkspaceDto } from '@montra/api-client';
import type { InsightDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { groupInsights } from '@/lib/ai';
import { groupCategories } from '@/lib/view-models';
import { Disclaimer } from './ai/shared';
import { useI18n } from './i18n';

/**
 * Insights (AI-08, AI-09): recurring payments the app spotted (accept → a recurring template), new
 * subscriptions, price increases, unusual amounts and possible duplicate charges. Numbers come from the API.
 */
export function InsightsList({
  workspace,
  initial,
  categories,
}: {
  workspace: WorkspaceDto;
  initial: InsightDto[];
  categories: CategoryDto[];
}) {
  const { t } = useI18n();
  const [items, setItems] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [categoryFor, setCategoryFor] = useState<Record<string, string>>({});
  const groups = groupCategories(workspace, categories, 'expense');
  const base = `/w/${workspace.id}`;

  async function act(item: InsightDto, kind: 'accept' | 'dismiss') {
    setBusy(item.id);
    setError(null);
    try {
      if (kind === 'accept') {
        const categoryId = categoryFor[item.id];
        await browserApi.acceptInsight(workspace.id, item.id, categoryId ? { categoryId } : {});
        setNotice(item.kind === 'recurring' ? t('insights.accepted_recurring') : t('insights.accepted'));
      } else {
        await browserApi.dismissInsight(workspace.id, item.id);
        setNotice(t('insights.dismissed'));
      }
      setItems((list) => list.filter((i) => i.id !== item.id));
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <p role="status" className="text-sm text-good">
        {notice}
      </p>
      {items.length === 0 ? (
        <p className="card text-sm text-muted">{t('insights.empty')}</p>
      ) : (
        groupInsights(items).map((g) => (
          <section key={g.kind} aria-labelledby={`insights-${g.kind}`} className="space-y-2">
            <h2 id={`insights-${g.kind}`} className="text-lg font-semibold">
              {t(`insights.kind.${g.kind}`)}{' '}
              <span className="num text-sm text-muted">({g.items.length})</span>
            </h2>
            <ul className="card divide-y divide-line p-0">
              {g.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-start gap-3 px-4 py-3"
                  data-testid="insight-row"
                >
                  <div className="min-w-0 flex-1">
                    {item.payee && <p className="font-medium">{item.payee}</p>}
                    <p className="text-sm">{item.message}</p>
                    {item.transactionId && (
                      <Link className="text-xs underline" href={`${base}/transactions/${item.transactionId}`}>
                        {t('insights.view_transaction')}
                      </Link>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {item.kind === 'recurring' && (
                      <select
                        className="input w-48"
                        aria-label={t('insights.category_for', { payee: item.payee ?? '' })}
                        value={categoryFor[item.id] ?? ''}
                        onChange={(e) => setCategoryFor({ ...categoryFor, [item.id]: e.target.value })}
                      >
                        <option value="">{t('insights.keep_category')}</option>
                        {groups.map((gr) => (
                          <optgroup key={gr.label} label={gr.label}>
                            {gr.categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    )}
                    {(item.kind === 'recurring' || item.kind === 'new_subscription') && (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busy === item.id}
                        onClick={() => void act(item, 'accept')}
                      >
                        {item.kind === 'recurring'
                          ? t('insights.create_recurring')
                          : t('insights.acknowledge')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy === item.id}
                      onClick={() => void act(item, 'dismiss')}
                    >
                      {t('insights.dismiss')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <Disclaimer kind="financial" />
    </div>
  );
}
