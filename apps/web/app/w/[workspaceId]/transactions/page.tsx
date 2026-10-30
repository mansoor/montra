import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { toTransactionRow } from '@/lib/view-models';
import { QuickAdd } from '@/components/quick-add';
import { TransferForm } from '@/components/transfer-form';
import { TransactionList } from '@/components/transaction-list';

export const metadata: Metadata = { title: 'Transactions' };
export const dynamic = 'force-dynamic';

export default async function TransactionsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, accounts, categories, transactions] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listTransactions(workspaceId, { limit: 100 }),
    ]),
  );
  const open = accounts.filter((a) => !a.archived);
  const today = todayIn(workspace.timeZone);
  const accountIds = new Set(accounts.map((a) => a.id));
  const categoryIds = new Set(categories.map((c) => c.id));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Transactions</h1>
      <QuickAdd workspace={workspace} accounts={open} categories={categories} today={today} />
      <TransferForm workspace={workspace} accounts={open} today={today} />
      <section aria-labelledby="list-heading" className="space-y-3">
        <h2 id="list-heading" className="text-lg font-semibold">
          Latest
        </h2>
        <TransactionList rows={transactions.map((t) => toTransactionRow(t, accountIds, categoryIds))} />
      </section>
    </div>
  );
}
