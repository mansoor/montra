'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ImportBatchDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { useI18n } from '../i18n';

/**
 * Discard an import that was never committed, with an inline confirmation step. Its preview goes; the uploaded file
 * is kept. `onDiscarded` receives the batch (status `discarded`); without it the page is refreshed, so a history row
 * leaves the list.
 */
export function DiscardButton({
  workspaceId,
  batchId,
  onDiscarded,
}: {
  workspaceId: string;
  batchId: string;
  onDiscarded?: (batch: ImportBatchDto) => void;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function discard() {
    setBusy(true);
    setError(null);
    try {
      const batch = await browserApi.discardImport(workspaceId, batchId);
      setConfirming(false);
      if (onDiscarded) onDiscarded(batch);
      router.refresh();
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!confirming)
    return (
      <button
        type="button"
        className="btn-secondary"
        data-testid="discard-import"
        onClick={() => setConfirming(true)}
      >
        {t('imports.discard.button')}
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <span className="text-sm">{t('imports.discard.confirm')}</span>
      <button type="button" className="btn-danger" disabled={busy} onClick={discard}>
        {t('imports.discard.yes')}
      </button>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
        {t('common.cancel')}
      </button>
      {error && (
        <span role="alert" className="text-sm text-bad">
          {error}
        </span>
      )}
    </span>
  );
}
