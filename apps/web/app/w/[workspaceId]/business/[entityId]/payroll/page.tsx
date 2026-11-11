import type { Metadata } from 'next';
import { ApiError } from '@montra/api-client';
import { todayIn } from '@montra/domain';
import { load, serverApi } from '@/lib/server-api';
import { PayrollHome } from '@/components/payroll/payroll-home';

export const metadata: Metadata = { title: 'Payroll' };
export const dynamic = 'force-dynamic';

const PAY_FROM = new Set(['checking', 'savings', 'cash']);

/** Pay schedules, pay runs and reimbursements (PRL-06..11; ADR-0034). */
export default async function PayrollPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, business, schedules, runs, reimbursements, accounts, categories] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getBusiness(workspaceId, entityId),
      api.listPaySchedules(workspaceId, entityId),
      api.listPayRuns(workspaceId, entityId),
      api.listReimbursements(workspaceId, { entityId }),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
    ]),
  );
  // Personal records need write access; a read-only grant still sees runs and reimbursements.
  const api = await serverApi();
  let people = null;
  try {
    people = await api.listPayrollPeople(workspaceId, { entityId });
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'payroll.no_access')) throw err;
  }
  return (
    <PayrollHome
      workspaceId={workspaceId}
      entityId={entityId}
      currency={business.currency}
      schedules={schedules}
      runs={runs}
      reimbursements={reimbursements}
      people={(people ?? []).filter((p) => p.status !== 'ended')}
      accounts={accounts
        .filter((a) => a.entityId === entityId && !a.archived && PAY_FROM.has(a.kind))
        .map((a) => ({ id: a.id, name: a.name }))}
      categories={categories
        .filter((c) => c.entityId === entityId && c.type === 'expense')
        .map((c) => ({ id: c.id, name: c.name }))}
      today={todayIn(workspace.timeZone)}
      canWrite={people !== null}
    />
  );
}
