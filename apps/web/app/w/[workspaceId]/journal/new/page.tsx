import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { ManualJournalForm } from '@/components/manual-journal-form';

export const metadata: Metadata = { title: 'New journal entry' };
export const dynamic = 'force-dynamic';

export default async function NewJournalPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, accounts, categories] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
    ]),
  );
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">New journal entry</h1>
      <p className="text-sm text-muted">
        For accountants and advanced users: opening balances, adjustments and depreciation. Debits must equal
        credits.
      </p>
      <ManualJournalForm
        workspace={workspace}
        accounts={accounts.filter((a) => !a.archived)}
        categories={categories}
        today={todayIn(workspace.timeZone)}
      />
    </div>
  );
}
