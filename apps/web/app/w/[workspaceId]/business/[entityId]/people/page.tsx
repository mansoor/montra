import type { Metadata } from 'next';
import { ApiError } from '@montra/api-client';
import { todayIn } from '@montra/domain';
import { load, serverApi } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { PeopleList } from '@/components/payroll/people-list';

export const metadata: Metadata = { title: 'People' };
export const dynamic = 'force-dynamic';

/** Employees and contractors (PRL-01; ADR-0032). Needs write access to the business. */
export default async function PeoplePage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, business] = await load((api) =>
    Promise.all([api.getWorkspace(workspaceId), api.getBusiness(workspaceId, entityId)]),
  );
  const { t } = await getI18n();
  const api = await serverApi();
  let people;
  try {
    people = await api.listPayrollPeople(workspaceId, { entityId });
  } catch (err) {
    // A read-only grant sees the business but not its people's personal data.
    if (err instanceof ApiError && err.code === 'payroll.no_access') {
      return <p className="card text-sm text-muted">{t('payroll.no_access')}</p>;
    }
    return load(() => Promise.reject(err));
  }
  return (
    <PeopleList
      workspaceId={workspaceId}
      entityId={entityId}
      currency={business.currency}
      people={people}
      today={todayIn(workspace.timeZone)}
    />
  );
}
