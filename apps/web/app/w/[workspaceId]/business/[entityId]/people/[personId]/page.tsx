import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { I9Panel } from '@/components/payroll/i9-panel';
import { PersonDetails } from '@/components/payroll/person-details';
import { W4Panel, W9Panel } from '@/components/payroll/tax-forms';

export const metadata: Metadata = { title: 'Person' };
export const dynamic = 'force-dynamic';

/** One employee or contractor: their record and onboarding forms (PRL-01..05). */
export default async function PersonPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string; personId: string }>;
}) {
  const { workspaceId, entityId, personId } = await params;
  const [workspace, business, person] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getBusiness(workspaceId, entityId),
      api.getPayrollPerson(workspaceId, personId),
    ]),
  );
  const [w4s, w9s, i9, schedules] = await load((api) =>
    Promise.all([
      person.kind === 'employee' ? api.listW4(workspaceId, personId) : Promise.resolve([]),
      person.kind === 'contractor' ? api.listW9(workspaceId, personId) : Promise.resolve([]),
      person.kind === 'employee' ? api.getI9(workspaceId, personId) : Promise.resolve(null),
      api.listPaySchedules(workspaceId, entityId),
    ]),
  );
  const { t } = await getI18n();
  const today = todayIn(workspace.timeZone);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/business/${entityId}/people`} className="text-sm underline">
          ← {t('business.tab_people')}
        </Link>
        <h2 className="text-lg font-semibold">{person.displayName}</h2>
        <span className="chip">
          {person.kind === 'employee' ? t('payroll.employee') : t('payroll.contractor')}
        </span>
      </div>
      <PersonDetails
        workspaceId={workspaceId}
        currency={business.currency}
        person={person}
        schedules={schedules
          .filter((s) => !s.archived || s.id === person.payScheduleId)
          .map((s) => ({ id: s.id, name: s.name }))}
      />
      {person.kind === 'employee' ? (
        <>
          <W4Panel
            workspaceId={workspaceId}
            currency={business.currency}
            person={person}
            forms={w4s}
            today={today}
          />
          <I9Panel
            workspaceId={workspaceId}
            person={person}
            i9={i9}
            business={{ name: business.legalName ?? business.name, address: business.address }}
            today={today}
          />
        </>
      ) : (
        <W9Panel workspaceId={workspaceId} person={person} forms={w9s} today={today} />
      )}
      <p className="text-xs text-muted">{t('payroll.forms_disclaimer')}</p>
    </div>
  );
}
