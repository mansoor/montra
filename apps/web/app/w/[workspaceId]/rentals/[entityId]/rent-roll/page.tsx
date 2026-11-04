import type { Metadata } from 'next';
import Link from 'next/link';
import { startOfMonth, todayIn, type CalendarDate } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { minorToInput } from '@/lib/money';
import { shiftMonth } from '@/lib/planning';
import { RENT_CHIP } from '@/lib/rentals';
import { Money } from '@/components/money';
import { RecordRent } from '@/components/rentals/lease-forms';
import { StatTile } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Rent roll' };
export const dynamic = 'force-dynamic';

/** What each lease owes this month, what's come in, and which units are empty (RNT-04). */
export default async function RentRollPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const sp = await searchParams;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const today = todayIn(workspace.timeZone);
  const month = /^\d{4}-\d{2}-01$/.test(sp.month ?? '') ? (sp.month as CalendarDate) : startOfMonth(today);
  const [roll, accounts] = await load((api) =>
    Promise.all([api.getRentRoll(workspaceId, entityId, month), api.listAccounts(workspaceId)]),
  );
  const { t, locale } = await getI18n();
  const ccy = roll.currency;
  const here = `/w/${workspaceId}/rentals/${entityId}`;
  const bank = [...accounts].sort(
    (a, b) => Number(b.entityId === entityId) - Number(a.entityId === entityId),
  );
  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}T00:00:00Z`),
  );
  return (
    <div className="space-y-5">
      <nav className="flex items-center justify-between gap-2" aria-label={t('rentals.month')}>
        <Link className="btn-secondary" href={`${here}/rent-roll?month=${shiftMonth(month, -1)}`}>
          ← {t('rentals.previous_month')}
        </Link>
        <h2 className="text-lg font-semibold" data-testid="roll-month">
          {title}
        </h2>
        <Link className="btn-secondary" href={`${here}/rent-roll?month=${shiftMonth(month, 1)}`}>
          {t('rentals.next_month')} →
        </Link>
      </nav>
      <section className="grid gap-3 sm:grid-cols-3" aria-label={t('rentals.at_a_glance')}>
        <StatTile label={t('rentals.expected')} value={<Money amount={roll.expected} currency={ccy} />} />
        <StatTile label={t('rentals.received')} value={<Money amount={roll.paid} currency={ccy} />} />
        <StatTile
          label={t('rentals.still_open')}
          value={<Money amount={roll.open} currency={ccy} />}
          tone={BigInt(roll.open) > 0n ? 'warn' : undefined}
        />
      </section>
      {roll.rows.length === 0 ? (
        <p className="card text-sm text-muted">{t('rentals.roll_empty')}</p>
      ) : (
        <ul className="space-y-2" aria-label={t('rentals.tab_rent_roll')}>
          {roll.rows.map((r) => (
            <li key={r.leaseId} className="card" data-testid="roll-row">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link className="font-medium underline" href={`${here}/leases/${r.leaseId}`}>
                    {r.propertyName} · {r.unitLabel}
                  </Link>
                  <p className="text-sm text-muted">{r.tenants.join(', ')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {r.charges.map((c) => (
                    <span key={c.id} className={RENT_CHIP[c.status]}>
                      {c.kind === 'late_fee' ? `${t('rentals.late_fee')}: ` : ''}
                      {t(`rentals.rent_${c.status}`)}
                    </span>
                  ))}
                  <span>
                    <Money amount={r.paid} currency={ccy} /> / <Money amount={r.expected} currency={ccy} />
                  </span>
                  {BigInt(r.credit) > 0n && (
                    <span className="chip chip-good">
                      {t('rentals.credit')}: <Money amount={r.credit} currency={ccy} />
                    </span>
                  )}
                </div>
              </div>
              {BigInt(r.open) > 0n && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm underline">
                    {t('rentals.record_payment')}
                  </summary>
                  <div className="mt-2">
                    <RecordRent
                      workspaceId={workspaceId}
                      leaseId={r.leaseId}
                      accounts={bank}
                      currency={ccy}
                      today={today}
                      suggested={minorToInput(BigInt(r.open), ccy)}
                    />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {roll.vacant.length > 0 && (
        <section className="card" aria-labelledby="vacant-title">
          <h2 id="vacant-title" className="mb-2 text-base font-semibold">
            {t('rentals.vacant')}
          </h2>
          <ul className="divide-y divide-line">
            {roll.vacant.map((u) => (
              <li key={u.unitId} className="flex justify-between gap-2 py-2 text-sm" data-testid="vacant-row">
                <span>
                  {u.propertyName} · {u.unitLabel}
                </span>
                {u.marketRent && <Money amount={u.marketRent} currency={ccy} />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
