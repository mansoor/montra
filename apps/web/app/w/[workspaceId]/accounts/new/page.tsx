import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { NewAccountForm } from '@/components/new-account-form';

export const metadata: Metadata = { title: 'Add account' };
export const dynamic = 'force-dynamic';

export default async function NewAccountPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Add an account</h1>
      <NewAccountForm workspace={workspace} today={todayIn(workspace.timeZone)} />
    </div>
  );
}
