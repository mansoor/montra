import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { PageHeader, LinkTabs } from '@/components/ui/page-header';
import { BudgetView } from '@/components/planning/budget-view';
import { BudgetSetup } from '@/components/planning/budget-setup';
import { IncomeManager } from '@/components/planning/income-manager';

export const metadata: Metadata = { title: 'Budget' };
export const dynamic = 'force-dynamic';

const TABS = ['plan', 'income', 'moves'] as const;
type Tab = (typeof TABS)[number];

/** The budget (BUD-01..10): one household budget per entity; tabs for the plan, income and move history. */
export default async function BudgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ start?: string; tab?: string; entityId?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? (sp.tab as Tab) : 'plan';
  const [workspace, budgets] = await load((api) =>
    Promise.all([api.getWorkspace(workspaceId), api.listBudgets(workspaceId)]),
  );
  const { t } = await getI18n();
  const active = budgets.filter((b) => !b.archived && b.memberId === null);
  const entities = workspace.entities;
  const entityId =
    sp.entityId ?? active[0]?.entityId ?? entities.find((e) => e.type === 'personal')?.id ?? entities[0]!.id;
  const budget = active.find((b) => b.entityId === entityId);
  const base = `/w/${workspaceId}/budget`;
  const qs = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ entityId: sp.entityId, start: sp.start, ...extra }))
      if (v) q.set(k, v);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };

  const entityTabs =
    entities.length > 1 ? (
      <nav aria-label={t('budget.entities')} className="segmented segmented-md">
        {entities.map((e) => (
          <a
            key={e.id}
            href={`${base}?entityId=${e.id}`}
            aria-current={e.id === entityId ? 'page' : undefined}
          >
            {e.name}
          </a>
        ))}
      </nav>
    ) : null;

  if (!budget) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('nav.budget')} subtitle={t('budget.none_yet')} actions={entityTabs} />
        <BudgetSetup workspace={workspace} entityId={entityId} today={todayIn(workspace.timeZone)} />
      </div>
    );
  }

  const [period, income, accounts] = await load((api) =>
    Promise.all([
      api.getBudgetPeriod(workspaceId, budget.id, sp.start ?? 'current'),
      tab === 'income' ? api.listExpectedIncome(workspaceId, entityId) : Promise.resolve([]),
      tab === 'income' ? api.listAccounts(workspaceId) : Promise.resolve([]),
    ]),
  );
  const moves =
    tab === 'moves' ? await load((api) => api.listBudgetMoves(workspaceId, budget.id, period.start)) : [];
  const names = new Map(period.groups.flatMap((g) => g.lines.map((l) => [l.categoryId, l.name] as const)));

  return (
    <div className="space-y-5">
      <PageHeader title={budget.name} subtitle={t(`budget.method_${budget.method}`)} actions={entityTabs} />
      <LinkTabs
        label={t('budget.sections')}
        current={tab}
        tabs={TABS.map((k) => ({
          key: k,
          href: qs({ tab: k === 'plan' ? undefined : k }),
          label: t(`budget.tab_${k}`),
        }))}
      />
      {tab === 'plan' && <BudgetView key={period.start} initial={period} workspaceId={workspaceId} />}
      {tab === 'income' && (
        <IncomeManager
          workspaceId={workspaceId}
          entityId={entityId}
          currency={budget.currency}
          items={income}
          accounts={accounts.filter((a) => a.entityId === entityId && !a.archived)}
          period={period}
        />
      )}
      {tab === 'moves' && (
        <section className="card-flush" aria-label={t('budget.tab_moves')}>
          {moves.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">{t('budget.no_moves')}</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col" className="px-4 py-2">
                    {t('budget.when')}
                  </th>
                  <th scope="col" className="px-2 py-2">
                    {t('budget.move_from_label')}
                  </th>
                  <th scope="col" className="px-2 py-2">
                    {t('budget.move_to')}
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    {t('budget.amount')}
                  </th>
                  <th scope="col" className="px-4 py-2">
                    {t('budget.note')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-2">
                      <DateText date={m.movedAt.slice(0, 10)} />
                    </td>
                    <td className="px-2 py-2">{m.from ? names.get(m.from) : t('budget.lta_label')}</td>
                    <td className="px-2 py-2">{m.to ? names.get(m.to) : t('budget.lta_label')}</td>
                    <td className="px-2 py-2 text-right">
                      <Money amount={m.amount} currency={budget.currency} />
                    </td>
                    <td className="px-4 py-2 text-muted">{m.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
