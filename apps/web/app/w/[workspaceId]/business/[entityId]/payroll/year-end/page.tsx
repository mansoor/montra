import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError } from '@montra/api-client';
import { todayIn } from '@montra/domain';
import { load, serverApi } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { YearEnd } from '@/components/payroll/year-end';

export const metadata: Metadata = { title: 'Year-end payroll forms' };
export const dynamic = 'force-dynamic';

/** W-2s, W-3, 1099-NECs, 1096 and the EFW2 file for one business and year (PRL-17..20). */
export default async function YearEndPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const sp = await searchParams;
  const [workspace, business, settings] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getBusiness(workspaceId, entityId),
      api.getPayrollSettings(workspaceId, entityId),
    ]),
  );
  const today = todayIn(workspace.timeZone);
  // Year-end forms are usually made in January for the year just ended.
  const year = /^\d{4}$/.test(sp.year ?? '')
    ? Number(sp.year)
    : Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) <= 2 ? 1 : 0);
  const { t } = await getI18n();
  let summary = null;
  try {
    summary = await (await serverApi()).getYearEnd(workspaceId, entityId, year);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'payroll.no_access')) throw err;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/business/${entityId}/payroll`} className="text-sm underline">
          ← {t('business.tab_payroll')}
        </Link>
        <h2 className="text-lg font-semibold">{t('payroll.year_end.title')}</h2>
      </div>
      {summary ? (
        <YearEnd
          workspaceId={workspaceId}
          entityId={entityId}
          currency={business.currency}
          year={year}
          summary={summary}
          settings={settings}
        />
      ) : (
        <p className="card text-sm text-muted">{t('payroll.year_end.no_access')}</p>
      )}
    </div>
  );
}
