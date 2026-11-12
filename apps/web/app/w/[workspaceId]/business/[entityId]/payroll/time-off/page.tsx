import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError } from '@montra/api-client';
import { todayIn } from '@montra/domain';
import { load, serverApi } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { LeaveSettings } from '@/components/payroll/leave-settings';

export const metadata: Metadata = { title: 'Time off' };
export const dynamic = 'force-dynamic';

/** Vacation and sick leave policies, the workweek, and every employee's balances (PRL-23..25; ADR-0036). */
export default async function TimeOffPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, settings] = await load((api) =>
    Promise.all([api.getWorkspace(workspaceId), api.getLeaveSettings(workspaceId, entityId)]),
  );
  const { t } = await getI18n();
  // Balances name people, so they need write access, as personal records do.
  let balances = null;
  try {
    balances = await (await serverApi()).listLeaveBalances(workspaceId, entityId);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'payroll.no_access')) throw err;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/business/${entityId}/payroll`} className="text-sm underline">
          ← {t('business.tab_payroll')}
        </Link>
        <h2 className="text-lg font-semibold">{t('payroll.time.title')}</h2>
      </div>
      <LeaveSettings
        workspaceId={workspaceId}
        entityId={entityId}
        settings={settings}
        balances={balances}
        canWrite={balances !== null}
        today={todayIn(workspace.timeZone)}
      />
    </div>
  );
}
