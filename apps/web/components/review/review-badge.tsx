'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { goSequence, isEditableTarget, reviewBadgeTotal } from '@/lib/review';
import { onChanges } from '@/lib/sync';
import { useI18n } from '../i18n';

/**
 * Count of what waits in Review for the nav: transactions to review, tax forms to check and files to provide again
 * (refreshes on navigation and on realtime transaction changes; tax forms and missing files change through their own
 * pages, so navigation covers them).
 */
export function ReviewCountBadge({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      Promise.all([
        browserApi.listReview(workspaceId, { limit: 1 }).then(
          (r) => r.total,
          () => null,
        ),
        browserApi.listTaxFormsToCheck(workspaceId).then(
          (r) => r.data.length,
          () => null,
        ),
        browserApi.listMissingFiles(workspaceId).then(
          (r) => r.length,
          () => null,
        ),
      ]).then(([transactions, taxForms, missingFiles]) => {
        const next = reviewBadgeTotal(transactions, taxForms, missingFiles);
        if (alive && next !== null) setTotal(next);
      });
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
    <span className="count-badge" data-testid="review-badge" aria-label={t('review.badge', { count: total })}>
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
