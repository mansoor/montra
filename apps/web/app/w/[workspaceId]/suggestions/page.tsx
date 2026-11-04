import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { EmptyState, LinkTabs, PageHeader } from '@/components/ui/page-header';
import { RecommendationList, RefreshRecommendations } from '@/components/planning/recommendations';

export const metadata: Metadata = { title: 'Suggestions' };
export const dynamic = 'force-dynamic';

const STATUSES = ['open', 'accepted', 'dismissed'] as const;

/** Recommendations (REC-01..08): open ones to act on, and what was accepted or dismissed. */
export default async function SuggestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { workspaceId } = await params;
  const raw = (await searchParams).status;
  const status = (STATUSES as readonly string[]).includes(raw ?? '')
    ? (raw as (typeof STATUSES)[number])
    : 'open';
  const [items, categories] = await load((api) =>
    Promise.all([api.listRecommendations(workspaceId, { status }), api.listCategories(workspaceId)]),
  );
  const { t } = await getI18n();
  const base = `/w/${workspaceId}/suggestions`;
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('nav.suggestions')}
        subtitle={t('rec.subtitle')}
        actions={<RefreshRecommendations workspaceId={workspaceId} />}
      />
      <LinkTabs
        label={t('rec.sections')}
        current={status}
        tabs={STATUSES.map((s) => ({
          key: s,
          href: s === 'open' ? base : `${base}?status=${s}`,
          label: t(`rec.status_${s}`),
        }))}
      />
      <RecommendationList
        workspaceId={workspaceId}
        items={items}
        categoryNames={Object.fromEntries(categories.map((c) => [c.id, c.name]))}
        empty={<EmptyState title={t('rec.empty')}>{t('rec.empty_hint')}</EmptyState>}
      />
    </div>
  );
}
