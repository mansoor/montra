import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { TransactionEditor } from '@/components/transaction-editor';
import { JournalView } from '@/components/journal-view';

export const metadata: Metadata = { title: 'Transaction' };
export const dynamic = 'force-dynamic';

export default async function TransactionPage({
  params,
}: {
  params: Promise<{ workspaceId: string; transactionId: string }>;
}) {
  const { workspaceId, transactionId } = await params;
  const [workspace, transaction, accounts, categories, members] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getTransaction(workspaceId, transactionId),
      api.listAccounts(workspaceId, { include: 'all' }),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
    ]),
  );
  // Journal detail (lock state, cleared status) per entry (DE-07).
  const entries = await load((api) =>
    Promise.all(transaction.entries.map((e) => api.getJournalEntry(workspaceId, e.id))),
  );
  const entityName = new Map(workspace.entities.map((e) => [e.id, e.name]));

  return (
    <div className="space-y-6">
      <Link href={`/w/${workspaceId}/transactions`} className="text-sm text-brand-600 underline">
        ← Transactions
      </Link>
      <h1 className="text-xl font-semibold">
        {transaction.payee || transaction.description || 'Transaction'}
      </h1>
      <TransactionEditor
        workspace={workspace}
        transaction={transaction}
        accounts={accounts}
        categories={categories}
        members={members}
      />
      <section aria-labelledby="journal-heading" className="space-y-3">
        <h2 id="journal-heading" className="text-lg font-semibold">
          Journal
        </h2>
        {entries.length === 0 ? (
          <p className="card text-sm text-muted">
            {transaction.status === 'scheduled'
              ? 'Scheduled: nothing is posted until you confirm it.'
              : 'No journal entries (deleted).'}
          </p>
        ) : (
          entries.map((e) => (
            <JournalView key={e.id} entry={e} entityName={entityName.get(e.entityId) ?? ''} />
          ))
        )}
      </section>
    </div>
  );
}
