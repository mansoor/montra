import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { RemindersPanel } from '@/components/rentals/rental-ops';

export const metadata: Metadata = { title: 'Reminders' };
export const dynamic = 'force-dynamic';

/** Lease ends, insurance renewals, property tax and inspections (RNT-12). */
export default async function RemindersPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, properties, reminders] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listProperties(workspaceId, entityId),
      api.listReminders(workspaceId, entityId),
    ]),
  );
  return (
    <RemindersPanel
      workspaceId={workspaceId}
      entityId={entityId}
      properties={properties}
      reminders={reminders}
      today={todayIn(workspace.timeZone)}
    />
  );
}
