import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import {
  BudgetPanel,
  DepreciationPanel,
  EditPropertyForm,
  UnitList,
} from '@/components/rentals/property-forms';
import { NewLeaseForm } from '@/components/rentals/lease-forms';

export const metadata: Metadata = { title: 'Property' };
export const dynamic = 'force-dynamic';

/** One property: its units, leases, depreciation and budget (RNT-01..03, RNT-09, RNT-14). */
export default async function PropertyPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string; propertyId: string }>;
}) {
  const { workspaceId, entityId, propertyId } = await params;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const today = todayIn(workspace.timeZone);
  const year = Number(today.slice(0, 4));
  const [property, leases, tenants, accounts, categories, depreciation, budget] = await load((api) =>
    Promise.all([
      api.getProperty(workspaceId, propertyId),
      api.listLeases(workspaceId, { entityId, propertyId }),
      api.listTenants(workspaceId, entityId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listDepreciation(workspaceId, propertyId, year),
      api.getPropertyBudget(workspaceId, propertyId),
    ]),
  );
  const { t } = await getI18n();
  const currency = budget.currency;
  const here = `/w/${workspaceId}/rentals/${entityId}`;
  return (
    <div className="space-y-5">
      <div>
        <Link href={`${here}/properties`} className="text-sm text-muted hover:text-ink">
          ← {t('rentals.tab_properties')}
        </Link>
        <h2 className="text-lg font-semibold">{property.name}</h2>
        {property.address && <p className="text-sm text-muted">{property.address}</p>}
      </div>
      <UnitList workspaceId={workspaceId} property={property} currency={currency} />
      <NewLeaseForm
        workspaceId={workspaceId}
        property={property}
        tenants={tenants}
        accounts={accounts.filter((a) => a.entityId === entityId)}
        currency={currency}
        today={today}
      />
      {leases.length > 0 && (
        <section className="card-flush overflow-x-auto" aria-labelledby="leases-title">
          <h2 id="leases-title" className="px-4 pt-3 text-base font-semibold">
            {t('rentals.leases')}
          </h2>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('rentals.tenants')}</th>
                <th className="px-2 py-2">{t('rentals.unit')}</th>
                <th className="px-2 py-2">{t('rentals.term')}</th>
                <th className="px-2 py-2 text-right">{t('rentals.rent')}</th>
                <th className="px-2 py-2 text-right">{t('rentals.deposit_held')}</th>
                <th className="px-4 py-2">{t('rentals.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {leases.map((l) => (
                <tr key={l.id} data-testid="lease-row">
                  <td className="px-4 py-2">
                    <Link className="underline" href={`${here}/leases/${l.id}`}>
                      {l.tenants.map((x) => x.name).join(', ')}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-sm">{l.unitLabel}</td>
                  <td className="px-2 py-2 text-sm">
                    <DateText date={l.startDate} /> –{' '}
                    {l.endDate ? <DateText date={l.endDate} /> : t('rentals.open_ended')}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={l.rent} currency={currency} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={l.depositHeld} currency={currency} />
                  </td>
                  <td className="px-4 py-2">
                    <span className={l.status === 'active' ? 'chip chip-good' : 'chip'}>
                      {t(`rentals.lease_${l.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <BudgetPanel
        workspaceId={workspaceId}
        budget={budget}
        categories={categories.filter((c) => c.entityId === entityId && c.type === 'expense')}
      />
      <DepreciationPanel
        workspaceId={workspaceId}
        property={property}
        schedules={depreciation}
        currency={currency}
        year={year}
      />
      <EditPropertyForm workspaceId={workspaceId} property={property} currency={currency} />
    </div>
  );
}
