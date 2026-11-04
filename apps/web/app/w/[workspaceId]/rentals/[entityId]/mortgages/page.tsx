import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { percentLabel } from '@/lib/rentals';
import { Money } from '@/components/money';
import { LoanSchedule, NewLoanForm } from '@/components/rentals/rental-ops';

export const metadata: Metadata = { title: 'Mortgages' };
export const dynamic = 'force-dynamic';

/** Each mortgage's schedule and what's been paid: principal, interest and escrow (RNT-08). */
export default async function MortgagesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, loans, properties, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listLoans(workspaceId, entityId),
      api.listProperties(workspaceId, entityId),
      api.listAccounts(workspaceId, { include: 'all' }),
    ]),
  );
  const schedules = await load((api) =>
    Promise.all(loans.map((l) => api.getLoanSchedule(workspaceId, l.id))),
  );
  const { t } = await getI18n();
  const currency = workspace.entities.find((e) => e.id === entityId)?.functionalCurrency ?? 'USD';
  const today = todayIn(workspace.timeZone);
  const own = accounts.filter((a) => a.entityId === entityId);
  const loanKinds = new Set(['loan', 'mortgage', 'line_of_credit']);
  const taken = new Set(loans.map((l) => l.loanAccountId));
  const paying = [...accounts]
    .filter((a) => !loanKinds.has(a.kind))
    .sort((a, b) => Number(b.entityId === entityId) - Number(a.entityId === entityId));
  return (
    <div className="space-y-5">
      <NewLoanForm
        workspaceId={workspaceId}
        properties={properties}
        loanAccounts={own.filter((a) => loanKinds.has(a.kind) && !taken.has(a.id))}
        currency={currency}
        today={today}
      />
      {loans.map((loan, i) => (
        <div key={loan.id} className="space-y-2" data-testid="loan">
          <h2 className="text-lg font-semibold">{loan.name}</h2>
          <p className="text-sm text-muted">
            {t('rentals.loan_terms', {
              rate: percentLabel(loan.rateBps),
              months: loan.termMonths,
            })}{' '}
            · {t('rentals.monthly_payment')}: <Money amount={loan.totalPayment} currency={loan.currency} /> ·{' '}
            {t('rentals.balance')}: <Money amount={loan.scheduledBalance} currency={loan.currency} />
          </p>
          <LoanSchedule
            workspaceId={workspaceId}
            loan={loan}
            rows={schedules[i]!}
            accounts={paying}
            base={`/w/${workspaceId}`}
          />
        </div>
      ))}
    </div>
  );
}
