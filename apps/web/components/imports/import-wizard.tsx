'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CategoryDto, ImportBatchDto, JobDto, UndoResultDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { canUndo, importErrorKey, isBusy, warningKey } from '@/lib/imports';
import { onChanges } from '@/lib/sync';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { MappingEditor } from './mapping-editor';
import { PreviewTable } from './preview-table';
import { UndoButton } from './undo-button';

const POLL_MS = 1000;

/**
 * One import batch from parsing to summary (IMP-03..09): processing → mapping (when needed) → preview →
 * commit progress → summary and undo. Polls while the worker is busy; a realtime push for the batch also
 * refreshes it.
 */
export function ImportWizard({
  workspaceId,
  initial,
  categories,
}: {
  workspaceId: string;
  initial: ImportBatchDto;
  categories: CategoryDto[];
}) {
  const { t, locale } = useI18n();
  const [batch, setBatch] = useState(initial);
  const [job, setJob] = useState<JobDto | null>(null);
  const [editing, setEditing] = useState(false);
  // Bumped whenever the rows behind the preview change (re-parse, bulk edits), so the table reloads.
  const [rowsVersion, setRowsVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastStatus = useRef(initial.status);
  const base = `/w/${workspaceId}`;

  const refresh = useCallback(async () => {
    try {
      const next = await browserApi.getImport(workspaceId, initial.id);
      if (next.jobId && (isBusy(next.status) || next.status === 'undone'))
        setJob(await browserApi.getJob(workspaceId, next.jobId));
      setBatch(next);
    } catch {
      // Offline for a moment; the next poll retries.
    }
  }, [workspaceId, initial.id]);

  useEffect(() => {
    if (lastStatus.current !== batch.status) {
      if (batch.status === 'preview') setRowsVersion((v) => v + 1);
      lastStatus.current = batch.status;
    }
    if (!isBusy(batch.status)) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [batch.status, refresh]);

  useEffect(
    () =>
      onChanges((changes) => {
        if (changes.some((c) => c.table === 'import_batch' && c.id === initial.id)) void refresh();
      }),
    [initial.id, refresh],
  );

  // The undo result lives on the undo job.
  useEffect(() => {
    if (batch.status === 'undone' && batch.jobId && job?.id !== batch.jobId)
      void browserApi.getJob(workspaceId, batch.jobId).then(setJob, () => undefined);
  }, [batch.status, batch.jobId, job?.id, workspaceId]);

  async function act(fn: () => Promise<ImportBatchDto>) {
    setBusy(true);
    setError(null);
    try {
      setBatch(await fn());
      setEditing(false);
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const failure = (raw: string | null) => {
    const key = importErrorKey(raw);
    return key ? t(key) : (raw ?? t('errors.generic'));
  };

  const errorLine = error && (
    <p role="alert" className="text-sm text-bad">
      {error}
    </p>
  );

  if (batch.status === 'uploaded' || batch.status === 'parsing')
    return (
      <section className="card space-y-2" aria-live="polite">
        <h2 className="font-semibold">{t('imports.processing.title')}</h2>
        <p role="status" className="text-sm text-muted">
          {t('imports.processing.reading', { file: batch.fileName })}
        </p>
        <progress className="w-full" aria-label={t('imports.processing.title')} />
      </section>
    );

  if (batch.status === 'failed')
    return (
      <section className="card space-y-3">
        <h2 className="font-semibold text-bad">{t('imports.failed.title')}</h2>
        <p role="alert" className="text-sm">
          {failure(batch.error)}
        </p>
        <Link href={`${base}/import?account=${batch.accountId}`} className="btn-secondary">
          {t('imports.failed.another')}
        </Link>
      </section>
    );

  if (batch.status === 'committing') {
    const undoing = job?.type === 'import.undo';
    const label = undoing ? t('imports.commit.undoing') : t('imports.commit.importing');
    return (
      <section className="card space-y-2" aria-live="polite">
        <h2 className="font-semibold">{label}</h2>
        <progress
          className="w-full"
          max={100}
          value={job?.progress ?? undefined}
          aria-label={label}
          data-testid="job-progress"
        />
        <p role="status" className="text-sm text-muted">
          {job?.progress != null
            ? t('imports.commit.percent', { percent: job.progress })
            : t('common.loading')}
        </p>
      </section>
    );
  }

  if (batch.status === 'committed' || batch.status === 'undone') {
    const undo = batch.status === 'undone' && job?.result ? (job.result as unknown as UndoResultDto) : null;
    return (
      <section className="space-y-4">
        <div className="card space-y-3" data-testid="import-summary">
          <h2 className="font-semibold">
            {batch.status === 'undone' ? t('imports.summary.undone_title') : t('imports.summary.title')}
          </h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(
              [
                ['read', 'imports.summary.read'],
                ['added', 'imports.summary.added'],
                ['matched', 'imports.summary.matched'],
                ['skipped', 'imports.summary.skipped'],
                ['failed', 'imports.summary.failed'],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="rounded-md border border-line p-3" data-testid={`summary-${k}`}>
                <dt className="text-xs uppercase tracking-wide text-muted">{t(label)}</dt>
                <dd className="num text-xl font-semibold">{batch.counts[k]}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <Link href={`${base}/accounts/${batch.accountId}`} className="btn-primary">
              {t('imports.summary.view_transactions')}
            </Link>
            {canUndo(batch) && (
              <UndoButton workspaceId={workspaceId} batchId={batch.id} onStarted={(b) => setBatch(b)} />
            )}
          </div>
          {batch.status === 'committed' && batch.undoUntil && (
            <p className="text-xs text-muted">
              {canUndo(batch)
                ? t('imports.summary.undo_until', {
                    date: new Date(batch.undoUntil).toLocaleDateString(locale),
                  })
                : t('imports.summary.undo_expired')}
            </p>
          )}
          {errorLine}
        </div>
        {batch.status === 'undone' && (
          <div className="card space-y-2" data-testid="undo-result">
            <h3 className="font-semibold">{t('imports.undo.result_title')}</h3>
            {undo ? (
              <>
                <p className="text-sm">
                  {t('imports.undo.result', { voided: undo.voided, restored: undo.restored })}
                </p>
                {undo.kept.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {undo.kept.map((k) => (
                      <li key={k.transactionId}>
                        <Link className="underline" href={`${base}/transactions/${k.transactionId}`}>
                          {t('imports.undo.kept_transaction')}
                        </Link>{' '}
                        — {t(`imports.kept_reason.${k.reason}`)}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">{t('common.loading')}</p>
            )}
            <Warnings warnings={batch.warnings} />
          </div>
        )}
      </section>
    );
  }

  // needs_mapping, or preview with the mapping editor opened on demand.
  if (batch.status === 'needs_mapping' || editing) {
    return (
      <section className="space-y-3">
        <Warnings warnings={batch.warnings} />
        {batch.analysis ? (
          <MappingEditor
            batch={batch}
            busy={busy}
            onCancel={batch.status === 'preview' ? () => setEditing(false) : undefined}
            onSave={(input) => act(() => browserApi.setImportMapping(workspaceId, batch.id, input))}
          />
        ) : (
          <p className="card text-sm text-muted">{t('imports.mapping.no_sample')}</p>
        )}
        {errorLine}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {batch.error && (
        <p role="alert" className="card border-bad/40 text-sm text-bad">
          {failure(batch.error)}
        </p>
      )}
      <Warnings warnings={batch.warnings} />
      <BalanceBanner batch={batch} />
      <PreviewTable
        key={rowsVersion}
        workspaceId={workspaceId}
        batch={batch}
        categories={categories}
        onBulkDone={() => setRowsVersion((v) => v + 1)}
        onEditMapping={batch.analysis ? () => setEditing(true) : undefined}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => act(() => browserApi.commitImport(workspaceId, batch.id))}
        >
          {t('imports.commit.button')}
        </button>
        <span className="text-sm text-muted">{t('imports.commit.hint')}</span>
      </div>
      {errorLine}
    </section>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  const { t } = useI18n();
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label={t('imports.warnings')}>
      {warnings.map((w) => (
        <li key={w} className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {t(warningKey(w))}
        </li>
      ))}
    </ul>
  );
}

/** Statement balance check (IMP-05): opening + transactions = closing. */
function BalanceBanner({ batch }: { batch: ImportBatchDto }) {
  const { t } = useI18n();
  if (batch.balanceCheck === 'n_a') return null;
  const range =
    batch.minDate && batch.maxDate ? (
      <>
        {' '}
        (<DateText date={batch.minDate} /> – <DateText date={batch.maxDate} />)
      </>
    ) : null;
  if (batch.balanceCheck === 'ok')
    return (
      <p
        role="status"
        data-testid="balance-banner"
        className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-good"
      >
        {t('imports.balance.ok')}
        {range}
      </p>
    );
  return (
    <p
      role="alert"
      data-testid="balance-banner"
      className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad"
    >
      {t('imports.balance.mismatch')}{' '}
      {batch.balanceGap && (
        <Money
          amount={batch.balanceGap.amount}
          currency={batch.balanceGap.currency}
          className="font-semibold"
        />
      )}
      {range}
    </p>
  );
}
