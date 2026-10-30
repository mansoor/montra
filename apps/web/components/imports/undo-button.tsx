'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ImportBatchDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { useI18n } from '../i18n';

/**
 * Undo a committed import (IMP-09), with an inline confirmation step. `navigate` opens the batch page to
 * follow the undo job; otherwise `onStarted` receives the batch (status `committing`).
 */
export function UndoButton({
  workspaceId,
  batchId,
  navigate,
  onStarted,
}: {
  workspaceId: string;
  batchId: string;
  navigate?: boolean;
  onStarted?: (batch: ImportBatchDto) => void;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      const batch = await browserApi.undoImport(workspaceId, batchId);
      setConfirming(false);
      if (navigate) router.push(`/w/${workspaceId}/imports/${batchId}`);
      onStarted?.(batch);
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!confirming)
    return (
      <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>
        {t('imports.undo.button')}
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <span className="text-sm">{t('imports.undo.confirm')}</span>
      <button type="button" className="btn-primary" disabled={busy} onClick={undo}>
        {t('imports.undo.yes')}
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
