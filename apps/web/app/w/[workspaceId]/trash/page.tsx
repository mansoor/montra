import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { isAdminRole } from '@/lib/settings';
import { TrashList } from '@/components/trash-list';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Trash' };
export const dynamic = 'force-dynamic';

/**
 * Deleted records, restorable for 30 days, and business receipts until their retention date (BAK-06, RCP-10). Owners
 * and admins can delete for good now what would go after 30 days.
 */
export default async function TrashPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [items, workspace] = await load((api) =>
    Promise.all([api.listTrash(workspaceId), api.getWorkspace(workspaceId)]),
  );
  const { t } = await getI18n();
  return (
    <div className="space-y-5">
      <PageHeader title={t('trash.title')} subtitle={t('trash.subtitle')} />
      <TrashList workspaceId={workspaceId} items={items} canDelete={isAdminRole(workspace.role)} />
    </div>
  );
}
