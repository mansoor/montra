import Link from 'next/link';
import type { ImportBatchDto } from '@montra/api-client';
import { getI18n } from '@/lib/i18n-server';

/**
 * Review's "Bank feed" (ADR-0055 §5): what a bank feed's sync brought that waits for a look, one import per account,
 * each opening the import's preview to commit, change or discard.
 */
export async function FeedImports({
  workspaceId,
  batches,
}: {
  workspaceId: string;
  batches: ImportBatchDto[];
}) {
  if (batches.length === 0) return null;
  const { t } = await getI18n();
  return (
    <section className="space-y-3" aria-labelledby="feed-imports-title" data-testid="feed-imports">
      <div>
        <h2 id="feed-imports-title" className="text-base font-semibold">
          {t('review.feed.title')}
        </h2>
        <p className="text-sm text-muted">{t('review.feed.intro')}</p>
      </div>
      <ul className="card-flush divide-y divide-line">
        {batches.map((b) => (
          <li
            key={b.id}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            data-testid="feed-import"
          >
            <div className="min-w-0">
              <p className="font-medium">{b.fileName}</p>
              <p className="text-xs text-muted">{t('review.feed.count', { count: b.counts.read })}</p>
            </div>
            <Link href={`/w/${workspaceId}/imports/${b.id}`} className="btn-secondary">
              {t('review.feed.open')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
