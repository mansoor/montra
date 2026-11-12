import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { AssetDetail } from '@/components/business/asset-detail';

export const metadata: Metadata = { title: 'Asset' };
export const dynamic = 'force-dynamic';

/** One asset: its depreciation, who holds it, and disposal (BIZ-16, BIZ-17). */
export default async function AssetPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string; assetId: string }>;
}) {
  const { workspaceId, entityId, assetId } = await params;
  const [workspace, asset, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getAsset(workspaceId, assetId),
      api.listAccounts(workspaceId),
    ]),
  );
  // Payroll people need write access to the business; without it the asset can't be handed over here anyway.
  const people = await load((api) => api.listPayrollPeople(workspaceId, { entityId }).catch(() => []));
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <Link href={`/w/${workspaceId}/business/${entityId}/assets`} className="text-sm underline">
        ← {t('business.tab_assets')}
      </Link>
      <AssetDetail
        workspaceId={workspaceId}
        asset={asset}
        today={todayIn(workspace.timeZone)}
        people={people.filter((p) => !p.endDate).map((p) => ({ id: p.id, name: p.displayName }))}
        accounts={accounts
          .filter(
            (a) => a.entityId === entityId && !a.archived && ['checking', 'savings', 'cash'].includes(a.kind),
          )
          .map((a) => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}
