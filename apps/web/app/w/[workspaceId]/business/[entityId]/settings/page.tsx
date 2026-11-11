import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { BusinessLogoForm, BusinessProfileForm, ExportForm } from '@/components/business/business-settings';

export const metadata: Metadata = { title: 'Business settings' };
export const dynamic = 'force-dynamic';

/** The business's profile, the export for an accountant, and how to give one access (BIZ-01, BIZ-13). */
export default async function BusinessSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, business, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getBusiness(workspaceId, entityId),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const year = todayIn(workspace.timeZone).slice(0, 4);
  return (
    <div className="space-y-5">
      <BusinessLogoForm workspaceId={workspaceId} profile={business} />
      <BusinessProfileForm
        workspaceId={workspaceId}
        profile={business}
        accounts={accounts.filter((a) => !a.archived)}
      />
      <p className="text-sm">
        <Link href={`/w/${workspaceId}/accounts/new?entityId=${entityId}`} className="underline">
          {t('business.add_account')}
        </Link>
      </p>
      <ExportForm workspaceId={workspaceId} entityId={entityId} from={`${year}-01-01`} to={`${year}-12-31`} />
      <section className="card space-y-2" aria-labelledby="accountant-title">
        <h2 id="accountant-title" className="text-base font-semibold">
          {t('business.accountant')}
        </h2>
        <p className="text-sm text-muted">{t('business.accountant_hint')}</p>
        <Link href={`/w/${workspaceId}/settings?tab=sharing`} className="btn-secondary inline-block">
          {t('business.accountant_invite')}
        </Link>
      </section>
    </div>
  );
}
