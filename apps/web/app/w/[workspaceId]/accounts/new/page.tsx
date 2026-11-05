import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { getI18n } from '@/lib/i18n-server';
import { load } from '@/lib/server-api';
import { PageHeader } from '@/components/ui/page-header';
import { NewAccountForm } from '@/components/new-account-form';

export const metadata: Metadata = { title: 'Add account' };
export const dynamic = 'force-dynamic';

export default async function NewAccountPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <PageHeader
        title="Add an account"
        back={{ href: `/w/${workspaceId}/accounts`, label: t('nav.accounts') }}
      />
      <NewAccountForm workspace={workspace} today={todayIn(workspace.timeZone)} />
    </div>
  );
}
