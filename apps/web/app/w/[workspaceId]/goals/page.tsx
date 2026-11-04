import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { EmptyState, PageHeader } from '@/components/ui/page-header';
import { GoalForm, GoalsList } from '@/components/planning/goals';

export const metadata: Metadata = { title: 'Goals' };
export const dynamic = 'force-dynamic';

export default async function GoalsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, goals, accounts, members] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listGoals(workspaceId),
      api.listAccounts(workspaceId),
      api.listFamilyMembers(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const active = goals.filter((g) => !g.archived);
  return (
    <div className="space-y-5">
      <PageHeader title={t('nav.goals')} subtitle={t('goal.subtitle')} />
      {active.length === 0 ? (
        <EmptyState title={t('goal.empty')}>{t('goal.empty_hint')}</EmptyState>
      ) : (
        <GoalsList goals={active} />
      )}
      <GoalForm
        workspace={workspace}
        accounts={accounts}
        members={members.filter((m) => m.status === 'active')}
      />
    </div>
  );
}
