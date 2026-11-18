'use client';

import { useEffect, useState } from 'react';
import type { FileStorageStateDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { vaultBadge } from '@/lib/vault';
import { useI18n } from './i18n';

/**
 * ADR-0054 §13: a small badge beside a document's files saying where they are with the household's Family Document
 * Vault: being sent, in someone's Inbox, filed, not taken, failed. Nothing for files that aren't sent, and nothing at
 * all when the badges can't be loaded: they never stand in the way of the document itself.
 */
export function VaultBadges({ workspaceId, fileIds }: { workspaceId: string; fileIds: readonly string[] }) {
  const { t } = useI18n();
  const [states, setStates] = useState<FileStorageStateDto[]>([]);
  const key = fileIds.slice(0, 100).join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    browserApi
      .getFileStorageStates(workspaceId, key.split(','))
      .then((s) => {
        if (live) setStates(s);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId, key]);

  const badges = new Map<string, NonNullable<ReturnType<typeof vaultBadge>>>();
  for (const s of states) {
    const b = vaultBadge(s);
    if (b && !badges.has(b.key)) badges.set(b.key, b);
  }
  if (!badges.size) return null;
  return (
    <span className="flex flex-wrap gap-1" data-testid="vault-badges">
      {[...badges.values()].map((b) => (
        <span
          key={b.key}
          className={`chip text-xs ${b.tone === 'good' ? 'text-good' : b.tone === 'bad' ? 'text-bad' : 'text-muted'}`}
          title={b.title ?? undefined}
        >
          {t(b.key)}
        </span>
      ))}
    </span>
  );
}
