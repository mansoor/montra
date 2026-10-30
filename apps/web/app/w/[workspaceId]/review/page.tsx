import type { Metadata } from 'next';
import { load, serverApi } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ReviewQueue } from '@/components/review/review-queue';

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
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('review.title')}</h1>
        <p className="text-sm text-muted">{t('review.intro')}</p>
      </div>
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
