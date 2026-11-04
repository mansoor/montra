import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { TrashList } from '@/components/trash-list';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Trash' };
export const dynamic = 'force-dynamic';

/** Deleted records, restorable for 30 days (BAK-06). */
export default async function TrashPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const items = await load((api) => api.listTrash(workspaceId));
  const { t } = await getI18n();
  return (
    <div className="space-y-5">
      <PageHeader title={t('trash.title')} subtitle={t('trash.subtitle')} />
      <TrashList workspaceId={workspaceId} items={items} />
    </div>
  );
}
