'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { MigrationDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { useI18n } from '../i18n';

/** Polls while the imports are reading or committing; one button imports them all, another makes the transfers. */
export function MigrationProgress({
  workspaceId,
  base,
  initial,
}: {
  workspaceId: string;
  base: string;
  initial: MigrationDto;
}) {
  const { t } = useI18n();
  const [m, setM] = useState(initial);
  const [busy, setBusy] = useState<'commit' | 'transfers' | null>(null);
  const [made, setMade] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = m.batches.some((b) => b.status === 'parsing' || b.status === 'committing');

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      browserApi.getMigration(workspaceId, m.id).then(setM, () => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [working, workspaceId, m.id]);

  const run = async (kind: 'commit' | 'transfers') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'commit') setM(await browserApi.commitMigration(workspaceId, m.id));
      else {
        const r = await browserApi.makeMigrationTransfers(workspaceId, m.id);
        setMade(r.made);
        setM(r.migration);
      }
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="switch-progress">
      <section className="card space-y-3">
        <p className="text-sm" role="status">
          {m.done ? t('switch.done') : m.ready ? t('switch.ready') : t('switch.preparing')}
        </p>
        <ul className="divide-y divide-line text-sm">
          {m.batches.map((b) => (
            <li key={b.batchId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{b.accountName}</span>
                <span className="block text-xs text-muted">
                  {b.fileName} · {t(`imports.status.${b.status}`)}
                  {b.status === 'committed' &&
                    ` · ${t('switch.batch_counts', { added: b.rowsAdded, matched: b.rowsMatched })}`}
                </span>
                {b.error && <span className="block text-xs text-bad">{b.error}</span>}
              </span>
              <Link href={`${base}/imports/${b.batchId}`} className="text-sm text-brand-600 underline">
                {t('switch.open_preview')}
              </Link>
            </li>
          ))}
        </ul>
        {m.ready && !m.done && (
          <button
            type="button"
            className="btn-primary"
            disabled={busy !== null}
            onClick={() => void run('commit')}
          >
            {busy === 'commit' || working ? t('switch.importing') : t('switch.import_all')}
          </button>
        )}
      </section>

      {m.done && m.transferPairs > 0 && (
        <section className="card space-y-2" data-testid="switch-transfers">
          <p className="text-sm">{t('switch.transfers', { count: m.transferPairs })}</p>
          <button
            type="button"
            className="btn-primary"
            disabled={busy !== null}
            onClick={() => void run('transfers')}
          >
            {t('switch.make_transfers')}
          </button>
        </section>
      )}
      {made !== null && (
        <p role="status" className="text-sm text-good">
          {t('switch.transfers_made', { count: made })}
        </p>
      )}

      {m.done && (
        <section className="card space-y-2">
          <p className="text-sm">{t('switch.next_steps')}</p>
          <div className="flex flex-wrap gap-2">
            <Link href={`${base}/review`} className="btn-secondary">
              {t('switch.go_review')}
            </Link>
            <Link href={base} className="btn-primary">
              {t('switch.go_home')}
            </Link>
          </div>
        </section>
      )}

      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
