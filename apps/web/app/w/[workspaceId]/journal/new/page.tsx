import type { Metadata } from 'next';
import { BackLink } from '@/components/ui/back-link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ManualJournalForm } from '@/components/manual-journal-form';

export const metadata: Metadata = { title: 'New journal entry' };
export const dynamic = 'force-dynamic';

export default async function NewJournalPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [[workspace, ledgerAccounts], { t }] = await Promise.all([
    load((api) => Promise.all([api.getWorkspace(workspaceId), api.listLedgerAccounts(workspaceId)])),
    getI18n(),
  ]);
  return (
    <div className="space-y-4">
      <BackLink href={`/w/${workspaceId}/journal`} className="text-sm text-brand-600 underline">
        ← {t('journal.title')}
      </BackLink>
      <h1 className="page-title">{t('journal.new')}</h1>
      <p className="text-sm text-muted">{t('journal.new_intro')}</p>
      <ManualJournalForm
        workspace={workspace}
        ledgerAccounts={ledgerAccounts}
        today={todayIn(workspace.timeZone)}
      />
    </div>
  );
}
