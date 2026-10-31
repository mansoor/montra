import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { InsightsList } from '@/components/insights-list';

export const metadata: Metadata = { title: 'Insights' };
export const dynamic = 'force-dynamic';

export default async function InsightsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, insights, categories] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listInsights(workspaceId, 'open'),
      api.listCategories(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('insights.title')}</h1>
        <p className="text-sm text-muted">{t('insights.intro')}</p>
      </div>
      <InsightsList workspace={workspace} initial={insights} categories={categories} />
    </div>
  );
}
