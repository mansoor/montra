import type { Metadata } from 'next';
import { load, serverApi } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { DocumentQueue } from '@/components/review/document-queue';
import { FeedImports } from '@/components/review/feed-imports';
import { FilesToProvide } from '@/components/review/files-to-provide';
import { ReviewQueue } from '@/components/review/review-queue';
import { TaxFormQueue } from '@/components/review/tax-form-queue';

export const metadata: Metadata = { title: 'Review' };
export const dynamic = 'force-dynamic';

const DEFAULT_THRESHOLD = 0.8;

export default async function ReviewPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, accounts, categories, members] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
    ]),
  );
  // The threshold only colors confidence chips; the queue works without the AI settings.
  const threshold = await (
    await serverApi()
  )
    .getAiSettings(workspaceId)
    .then((s) => s.threshold)
    .catch(() => DEFAULT_THRESHOLD);
  // ADR-0055 §5: what a bank feed's sync brought that waits for a look. Viewers can't import, so they don't see it.
  const feedImports =
    workspace.role === 'viewer'
      ? []
      : await (await serverApi()).listFeedImportsWaiting(workspaceId).catch(() => []);
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">{t('review.title')}</h1>
        <p className="text-sm text-muted">{t('review.intro')}</p>
      </div>
      <DocumentQueue workspaceId={workspace.id} role={workspace.role} accounts={accounts} />
      <FeedImports workspaceId={workspace.id} batches={feedImports} />
      {workspace.role !== 'viewer' && <FilesToProvide workspaceId={workspace.id} />}
      {workspace.role !== 'viewer' && workspace.baseCurrency === 'USD' && (
        <TaxFormQueue workspaceId={workspace.id} />
      )}
      <ReviewQueue
        workspace={workspace}
        accounts={accounts}
        categories={categories}
        members={members}
        threshold={threshold}
      />
    </div>
  );
}
