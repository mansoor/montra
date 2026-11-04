import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { Money } from '@/components/money';
import { NewPropertyForm } from '@/components/rentals/property-forms';

export const metadata: Metadata = { title: 'Properties' };
export const dynamic = 'force-dynamic';

/** Properties of a portfolio (RNT-01). */
export default async function PropertiesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, properties] = await load((api) =>
    Promise.all([api.getWorkspace(workspaceId), api.listProperties(workspaceId, entityId)]),
  );
  const { t } = await getI18n();
  const currency = workspace.entities.find((e) => e.id === entityId)?.functionalCurrency ?? 'USD';
  const here = `/w/${workspaceId}/rentals/${entityId}/properties`;
  return (
    <div className="space-y-5">
      <NewPropertyForm workspaceId={workspaceId} entityId={entityId} currency={currency} />
      {properties.length > 0 && (
        <section className="card-flush overflow-x-auto" aria-label={t('rentals.tab_properties')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('rentals.property')}</th>
                <th className="px-2 py-2">{t('rentals.type')}</th>
                <th className="px-2 py-2 text-right">{t('rentals.units')}</th>
                <th className="px-2 py-2 text-right">{t('rentals.occupied')}</th>
                <th className="px-4 py-2 text-right">{t('rentals.current_value')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {properties.map((p) => (
                <tr key={p.id} data-testid="property-row">
                  <td className="px-4 py-2">
                    <Link className="font-medium underline" href={`${here}/${p.id}`}>
                      {p.name}
                    </Link>
                    {p.address && <span className="block text-xs text-muted">{p.address}</span>}
                    {p.archived && <span className="chip">{t('rentals.archived_label')}</span>}
                  </td>
                  <td className="px-2 py-2 text-sm">{t(`rentals.type_${p.type}`)}</td>
                  <td className="num px-2 py-2 text-right">{p.units.length}</td>
                  <td className="num px-2 py-2 text-right">
                    {p.units.filter((u) => u.status === 'occupied').length}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {p.currentValue ? <Money amount={p.currentValue} currency={currency} /> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
