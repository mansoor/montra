import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { TenantDetails } from '@/components/rentals/tenant-forms';

export const metadata: Metadata = { title: 'Tenant' };
export const dynamic = 'force-dynamic';

/** One tenant: their details and the leases they're on, current first (RNT-17). */
export default async function TenantPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string; tenantId: string }>;
}) {
  const { workspaceId, entityId, tenantId } = await params;
  const [workspace, tenant] = await load((api) =>
    Promise.all([api.getWorkspace(workspaceId), api.getTenant(workspaceId, tenantId)]),
  );
  const { t } = await getI18n();
  const currency = workspace.entities.find((e) => e.id === entityId)?.functionalCurrency ?? 'USD';
  const here = `/w/${workspaceId}/rentals/${entityId}`;
  return (
    <div className="space-y-5">
      <div>
        <Link href={`${here}/tenants`} className="text-sm text-muted hover:text-ink">
          ← {t('rentals.tab_tenants')}
        </Link>
        <h2 className="text-lg font-semibold">{tenant.name}</h2>
        <p className="text-sm text-muted" data-testid="tenant-current">
          {tenant.current ? (
            <>
              {t('rentals.lives_at')}:{' '}
              <Link className="underline" href={`${here}/properties/${tenant.current.propertyId}`}>
                {tenant.current.propertyName} · {tenant.current.unitLabel}
              </Link>
            </>
          ) : (
            t('rentals.no_current_lease')
          )}
        </p>
      </div>
      <TenantDetails
        workspaceId={workspaceId}
        tenant={tenant}
        currency={currency}
        today={todayIn(workspace.timeZone)}
      />
      <section className="card-flush overflow-x-auto" aria-labelledby="tenant-leases-title">
        <h2 id="tenant-leases-title" className="px-4 pt-3 text-base font-semibold">
          {t('rentals.leases')}
        </h2>
        {tenant.leases.length === 0 ? (
          <p className="px-4 pb-3 text-sm text-muted">{t('rentals.tenant_no_leases')}</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('rentals.property')}</th>
                <th className="px-2 py-2">{t('rentals.unit')}</th>
                <th className="px-2 py-2">{t('rentals.term')}</th>
                <th className="px-2 py-2 text-right">{t('rentals.rent')}</th>
                <th className="px-2 py-2">{t('rentals.on_lease_as')}</th>
                <th className="px-4 py-2">{t('rentals.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {tenant.leases.map((l) => (
                <tr key={`${l.leaseId}-${l.role}`} data-testid="tenant-lease-row">
                  <td className="px-4 py-2">
                    <Link className="underline" href={`${here}/leases/${l.leaseId}`}>
                      {l.propertyName}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-sm">{l.unitLabel}</td>
                  <td className="px-2 py-2 text-sm">
                    <DateText date={l.startDate} /> –{' '}
                    {l.endedOn ? (
                      <DateText date={l.endedOn} />
                    ) : l.endDate ? (
                      <DateText date={l.endDate} />
                    ) : (
                      t('rentals.month_to_month')
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={l.rent} currency={l.currency} />
                  </td>
                  <td className="px-2 py-2 text-sm">{t(`rentals.lease_role_${l.role}`)}</td>
                  <td className="px-4 py-2">
                    <span className={l.status === 'active' ? 'chip chip-good' : 'chip'}>
                      {t(`rentals.lease_${l.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
