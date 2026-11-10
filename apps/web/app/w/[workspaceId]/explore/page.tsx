import { CHART_MONTHS } from '@montra/schemas';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { PageHeader } from '@/components/ui/page-header';
import { ExploreView } from '@/components/explore/explore-view';

/**
 * Explore spending (FLOW-01): pick categories and a period to see the habit month by month, in a chart and a table,
 * with what each category says and what-ifs on them. Nothing here changes the data.
 */
export default async function ExplorePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ months?: string; c?: string; memberId?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const months = (CHART_MONTHS as readonly number[]).includes(Number(sp.months)) ? Number(sp.months) : 6;
  const categoryIds = (sp.c ?? '').split(',').filter(Boolean);
  const [[data, goals], { t }] = await Promise.all([
    load((api) =>
      Promise.all([
        api.getSpendingExplore(workspaceId, {
          months,
          ...(categoryIds.length ? { categoryIds } : {}),
          ...(sp.memberId ? { memberId: sp.memberId } : {}),
        }),
        api.listGoals(workspaceId),
      ]),
    ),
    getI18n(),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title={t('explore.title')} subtitle={t('explore.subtitle')} />
      <ExploreView
        base={`/w/${workspaceId}`}
        data={data}
        goals={goals
          .filter((g) => g.target !== null)
          .map((g) => ({
            id: g.id,
            name: g.name,
            remaining: String(BigInt(g.target!) - BigInt(g.progress.saved)),
          }))}
      />
    </div>
  );
}
