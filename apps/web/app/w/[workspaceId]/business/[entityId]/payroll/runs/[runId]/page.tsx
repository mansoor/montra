import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError } from '@montra/api-client';
import { load, serverApi } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { PayRunEditor } from '@/components/payroll/pay-run-editor';

export const metadata: Metadata = { title: 'Pay run' };
export const dynamic = 'force-dynamic';

const PAY_FROM = new Set(['checking', 'savings', 'cash']);

/** One pay run (PRL-07..09). */
export default async function PayRunPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string; runId: string }>;
}) {
  const { workspaceId, entityId, runId } = await params;
  const [business, run, accounts] = await load((api) =>
    Promise.all([
      api.getBusiness(workspaceId, entityId),
      api.getPayRun(workspaceId, runId),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  let canWrite = true;
  try {
    await (await serverApi()).listPayrollPeople(workspaceId, { entityId, kind: 'employee' });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'payroll.no_access') canWrite = false;
    else throw err;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/business/${entityId}/payroll`} className="text-sm underline">
          ← {t('business.tab_payroll')}
        </Link>
        <h2 className="text-lg font-semibold">{t('payroll.run.title')}</h2>
      </div>
      <PayRunEditor
        workspaceId={workspaceId}
        currency={business.currency}
        run={run}
        accounts={accounts
          .filter((a) => a.entityId === entityId && PAY_FROM.has(a.kind))
          .map((a) => ({ id: a.id, name: a.name }))}
        canWrite={canWrite}
      />
    </div>
  );
}
