import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { LoanPaymentsList } from '@/components/accounts/loan-panel';
import { RecurringManager } from '@/components/recurring-manager';

export const metadata: Metadata = { title: 'Recurring' };
export const dynamic = 'force-dynamic';

export default async function RecurringPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, recurring, accounts, categories, loans] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listRecurring(workspaceId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listLoans(workspaceId),
    ]),
  );
  return (
    <div className="space-y-4">
      <h1 className="page-title">Recurring</h1>
      <p className="text-sm text-muted">
        Rent, salary and subscriptions. Each occurrence is scheduled for you to confirm, or posted
        automatically.
      </p>
      <LoanPaymentsList workspaceId={workspaceId} loans={loans} accounts={accounts} />
      <RecurringManager
        workspace={workspace}
        recurring={recurring}
        accounts={accounts.filter((a) => !a.archived)}
        categories={categories}
        today={todayIn(workspace.timeZone)}
      />
    </div>
  );
}
