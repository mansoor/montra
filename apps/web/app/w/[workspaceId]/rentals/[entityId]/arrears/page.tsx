import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { WaiveCharge } from '@/components/rentals/lease-forms';

export const metadata: Metadata = { title: 'Arrears' };
export const dynamic = 'force-dynamic';

/** Who owes what, and how late: the landlord's follow-up list (RNT-05). */
export default async function ArrearsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const arrears = await load((api) => api.getArrears(workspaceId, entityId));
  const { t } = await getI18n();
  const ccy = arrears.currency;
  const here = `/w/${workspaceId}/rentals/${entityId}`;
  if (arrears.rows.length === 0) return <p className="card text-sm text-muted">{t('rentals.no_arrears')}</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {t('rentals.arrears_total')}: <Money amount={arrears.total} currency={ccy} />
      </p>
      <ul className="space-y-2" aria-label={t('rentals.tab_arrears')}>
        {arrears.rows.map((r) => (
          <li key={r.leaseId} className="card" data-testid="arrears-row">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <Link className="font-medium underline" href={`${here}/leases/${r.leaseId}`}>
                  {r.propertyName} · {r.unitLabel}
                </Link>
                <p className="text-sm text-muted">{r.tenants.join(', ')}</p>
              </div>
              <div className="text-right text-sm">
                <p className="font-medium">
                  <Money amount={r.total} currency={ccy} />
                </p>
                <p className="text-muted">{t('rentals.days_late', { count: r.daysLate })}</p>
              </div>
            </div>
            <ul className="mt-2 divide-y divide-line border-t border-line">
              {r.charges.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
                  <span>
                    {c.kind === 'late_fee' ? t('rentals.late_fee') : t('rentals.rent')} ·{' '}
                    <DateText date={c.dueDate} /> · <Money amount={c.open} currency={ccy} />
                  </span>
                  <WaiveCharge
                    workspaceId={workspaceId}
                    chargeId={c.id}
                    version={c.version}
                    waived={c.status === 'waived'}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
