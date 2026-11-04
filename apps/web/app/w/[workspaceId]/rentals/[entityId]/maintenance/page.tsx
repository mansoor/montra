import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { MaintenanceLog } from '@/components/rentals/rental-ops';

export const metadata: Metadata = { title: 'Maintenance' };
export const dynamic = 'force-dynamic';

/** The maintenance log (RNT-13). */
export default async function MaintenancePage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, properties, items] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listProperties(workspaceId, entityId),
      api.listMaintenance(workspaceId, { entityId }),
    ]),
  );
  return (
    <MaintenanceLog
      workspaceId={workspaceId}
      properties={properties}
      items={items}
      currency={workspace.entities.find((e) => e.id === entityId)?.functionalCurrency ?? 'USD'}
      today={todayIn(workspace.timeZone)}
      fileHref={`/api/v1/workspaces/${workspaceId}/rentals`}
    />
  );
}
