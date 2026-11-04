import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { percentLabel } from '@/lib/rentals';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { DepositPanel, EndLeaseForm, PaymentList, RecordRent } from '@/components/rentals/lease-forms';

export const metadata: Metadata = { title: 'Lease' };
export const dynamic = 'force-dynamic';

/** One lease: its terms, payments and security deposit (RNT-03, RNT-04, RNT-10). */
export default async function LeasePage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string; leaseId: string }>;
}) {
  const { workspaceId, entityId, leaseId } = await params;
  const [workspace, lease, payments, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getLease(workspaceId, leaseId),
      api.listRentPayments(workspaceId, leaseId),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const today = todayIn(workspace.timeZone);
  const ccy = lease.currency;
  const base = `/w/${workspaceId}`;
  const here = `${base}/rentals/${entityId}`;
  // Money can land in any account, though the portfolio's own come first.
  const bank = [...accounts].sort(
    (a, b) => Number(b.entityId === entityId) - Number(a.entityId === entityId),
  );
  return (
    <div className="space-y-5">
      <div>
        <Link href={`${here}/properties/${lease.propertyId}`} className="text-sm text-muted hover:text-ink">
          ← {lease.propertyName}
        </Link>
        <h2 className="text-lg font-semibold">
          {lease.tenants.map((x) => x.name).join(', ')} · {lease.unitLabel}
        </h2>
      </div>
      <section className="card" aria-labelledby="terms-title">
        <h2 id="terms-title" className="mb-2 text-base font-semibold">
          {t('rentals.terms')}
        </h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted">{t('rentals.rent')}</dt>
            <dd>
              <Money amount={lease.rent} currency={ccy} />
            </dd>
          </div>
          <div>
            <dt className="text-muted">{t('rentals.due_day')}</dt>
            <dd className="num">{lease.dueDay}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('rentals.term')}</dt>
            <dd>
              <DateText date={lease.startDate} /> –{' '}
              {lease.endDate ? <DateText date={lease.endDate} /> : t('rentals.open_ended')}
            </dd>
          </div>
          <div>
            <dt className="text-muted">{t('rentals.status')}</dt>
            <dd>{t(`rentals.lease_${lease.status}`)}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('rentals.grace_days')}</dt>
            <dd className="num">{lease.lateGraceDays}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('rentals.late_fee')}</dt>
            <dd>
              <Money amount={lease.lateFeeFlat} currency={ccy} /> + {percentLabel(lease.lateFeeBps)}
              {lease.lateFeeCap && (
                <>
                  {' '}
                  ({t('rentals.capped_at')} <Money amount={lease.lateFeeCap} currency={ccy} />)
                </>
              )}
            </dd>
          </div>
        </dl>
        {lease.fileIds.length > 0 && (
          <p className="mt-2 text-sm">
            {lease.fileIds.map((id, i) => (
              <a
                key={id}
                className="mr-3 underline"
                href={`/api/v1/workspaces/${workspaceId}/rentals/leases/${lease.id}/files/${id}`}
                target="_blank"
                rel="noreferrer"
              >
                {t('rentals.lease_file_n', { n: i + 1 })}
              </a>
            ))}
          </p>
        )}
        {lease.status !== 'ended' && (
          <div className="mt-3 border-t border-line pt-3">
            <EndLeaseForm workspaceId={workspaceId} lease={lease} today={today} />
          </div>
        )}
      </section>
      <section className="card space-y-3" aria-labelledby="payments-title">
        <h2 id="payments-title" className="text-base font-semibold">
          {t('rentals.payments')}
        </h2>
        <RecordRent
          workspaceId={workspaceId}
          leaseId={lease.id}
          accounts={bank}
          currency={ccy}
          today={today}
          suggested=""
        />
        <PaymentList
          workspaceId={workspaceId}
          leaseId={lease.id}
          payments={payments}
          currency={ccy}
          base={base}
        />
      </section>
      <DepositPanel workspaceId={workspaceId} lease={lease} accounts={bank} today={today} />
    </div>
  );
}
