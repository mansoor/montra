'use client';

import { useEffect, useState } from 'react';
import type { CategoryProposalsResponse } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { useI18n } from '../i18n';

/**
 * Categories proposed from the first import (UP-03): new categories that fit the statement's payees, with
 * examples and row counts. Accepting creates them and re-suggests the preview rows.
 */
export function CategoryProposals({
  workspaceId,
  batchId,
  onAccepted,
}: {
  workspaceId: string;
  batchId: string;
  onAccepted: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<CategoryProposalsResponse | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    browserApi.categoryProposals(workspaceId, batchId).then(
      (r) => {
        if (!alive) return;
        setData(r);
        setPicked(new Set(r.proposals.filter((p) => !p.exists).map((p) => p.name)));
      },
      () => undefined, // optional step: the preview works without it
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, batchId]);

  const fresh = data?.proposals.filter((p) => !p.exists) ?? [];
  if (hidden || fresh.length === 0) return null;

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await browserApi.acceptCategoryProposals(workspaceId, batchId, { names: [...picked] });
      setHidden(true);
      onAccepted();
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3" aria-labelledby="proposals-title" data-testid="category-proposals">
      <div>
        <h2 id="proposals-title" className="font-semibold">
          {t('imports.proposals.title')}
        </h2>
        <p className="text-sm text-muted">
          {data?.source === 'ai' ? t('imports.proposals.intro_ai') : t('imports.proposals.intro_reference')}
        </p>
      </div>
      <ul className="space-y-2">
        {fresh.map((p) => (
          <li key={p.name}>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.has(p.name)}
                onChange={() =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (n.has(p.name)) n.delete(p.name);
                    else n.add(p.name);
                    return n;
                  })
                }
              />
              <span>
                <span className="font-medium">{p.name}</span>{' '}
                <span className="text-xs text-muted">
                  {p.group} · {t('imports.proposals.rows', { count: p.rows })}
                </span>
                {p.payees.length > 0 && (
                  <span className="block text-xs text-muted">{p.payees.slice(0, 4).join(', ')}</span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" disabled={busy || picked.size === 0} onClick={accept}>
          {t('imports.proposals.accept', { count: picked.size })}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setHidden(true)}>
          {t('imports.proposals.skip')}
        </button>
      </div>
    </section>
  );
}
