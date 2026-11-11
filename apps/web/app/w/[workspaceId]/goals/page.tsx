import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { EmptyState, PageHeader } from '@/components/ui/page-header';
import { GoalForm, GoalsBoard } from '@/components/planning/goals';

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
  return (
    <div className="space-y-5">
      <PageHeader title={t('nav.goals')} subtitle={t('goal.subtitle')} />
      <GoalsBoard
        goals={goals}
        workspace={workspace}
        accounts={accounts}
        members={members}
        empty={<EmptyState title={t('goal.empty')}>{t('goal.empty_hint')}</EmptyState>}
      />
      <GoalForm workspace={workspace} accounts={accounts} members={members} />
    </div>
  );
}
