import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { sourceLabel, switchSource } from '@/lib/switch-sources';
import { PageHeader } from '@/components/ui/page-header';
import { MigrationProgress } from '@/components/switch/migration-progress';

export const dynamic = 'force-dynamic';

/** A switch in progress: each account's import previews, then everything is imported and transfers are paired. */
export default async function MigrationPage({
  params,
}: {
  params: Promise<{ workspaceId: string; migrationId: string }>;
}) {
  const { workspaceId, migrationId } = await params;
  const [migration, { t }] = await Promise.all([
    load((api) => api.getMigration(workspaceId, migrationId)),
    getI18n(),
  ]);
  const app = switchSource(migration.source);
  return (
    <div className="space-y-6">
      <PageHeader
        title={t('switch.progress_title', { app: app ? sourceLabel(app, t) : t('switch.other_name') })}
      />
      <MigrationProgress workspaceId={workspaceId} base={`/w/${workspaceId}`} initial={migration} />
    </div>
  );
}
