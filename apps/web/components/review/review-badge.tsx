'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { goSequence, isEditableTarget } from '@/lib/review';
import { onChanges } from '@/lib/sync';
import { useI18n } from '../i18n';

/** Count of transactions waiting for review, for the nav (refreshes on navigation and on realtime changes). */
export function ReviewCountBadge({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      browserApi.listReview(workspaceId, { limit: 1 }).then(
        (r) => alive && setTotal(r.total),
        () => undefined,
      );
    void refresh();
    const off = onChanges((changes) => {
      if (changes.some((c) => c.table === 'transaction')) void refresh();
    });
    return () => {
      alive = false;
      off();
    };
  }, [workspaceId, pathname]);

  if (!total) return null;
  return (
    <span
      className="ml-1 rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white"
      data-testid="review-badge"
      aria-label={t('review.badge', { count: total })}
    >
      {total > 999 ? '999+' : total}
    </span>
  );
}

/** Two-key shortcuts available on every workspace page (PLT-10): g r review, g t transactions, g i insights, g u rules. */
export function GlobalShortcuts({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const seq = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const r = goSequence(seq.current, e.key, Date.now());
      seq.current = r.state;
      if (r.target) {
        e.preventDefault();
        router.push(`/w/${workspaceId}/${r.target}`);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, workspaceId]);
  return null;
}
