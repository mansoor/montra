import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { TransactionEditor } from '@/components/transaction-editor';
import { JournalView } from '@/components/journal-view';
import { TransactionFx } from '@/components/receipts/transaction-fx';
import { ReceiptUpload } from '@/components/receipts/receipt-upload';

export const metadata: Metadata = { title: 'Transaction' };
export const dynamic = 'force-dynamic';

export default async function TransactionPage({
  params,
}: {
  params: Promise<{ workspaceId: string; transactionId: string }>;
}) {
  const { workspaceId, transactionId } = await params;
  const [workspace, transaction, accounts, categories, members, taxLines] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getTransaction(workspaceId, transactionId),
      api.listAccounts(workspaceId, { include: 'all' }),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
      api.listTaxLines(workspaceId),
    ]),
  );
  // Journal detail (lock state, cleared status) per entry (DE-07).
  const entries = await load((api) =>
    Promise.all(transaction.entries.map((e) => api.getJournalEntry(workspaceId, e.id))),
  );
  const { t } = await getI18n();
  const entityName = new Map(workspace.entities.map((e) => [e.id, e.name]));
  // CUR-05: rates apply when the paying account's currency differs from its entity's.
  const account = accounts.find((a) => a.id === transaction.accountId);
  const functional = workspace.entities.find((e) => e.id === account?.entityId)?.functionalCurrency;
  const foreignAccount = Boolean(account && functional && account.currency !== functional);
  const standard = transaction.entries.some((e) => e.kind === 'standard') && transaction.amount !== null;
  // AI-10: a hint at the tax line its categories usually go on, for bookkeeping; not tax advice.
  const hints = [
    ...new Map(
      (transaction.splits ?? []).flatMap((split) => {
        const code = categories.find((c) => c.id === split.accountId)?.taxLineCode;
        const line = taxLines.find((l) => l.code === code);
        return line ? [[line.code, line] as const] : [];
      }),
    ).values(),
  ];

  return (
    <div className="space-y-6">
      <Link href={`/w/${workspaceId}/transactions`} className="text-sm text-brand-600 underline">
        ← {t('nav.transactions')}
      </Link>
      <h1 className="page-title">{transaction.payee || transaction.description || t('editor.untitled')}</h1>
      <TransactionEditor
        workspace={workspace}
        transaction={transaction}
        accounts={accounts}
        categories={categories}
        members={members}
      />
      {hints.map((line) => (
        <p key={line.code} className="text-sm text-muted" data-testid="tax-hint">
          {t(line.form === 'schedule_c' ? 'tax_hint.schedule_c' : 'tax_hint.schedule_e', {
            line: line.line,
            label: line.label,
          })}
          {line.deductibleBps < 10000 && ` ${t('tax_hint.partly', { percent: line.deductibleBps / 100 })}`}
        </p>
      ))}
      <TransactionFx workspaceId={workspaceId} transaction={transaction} foreignAccount={foreignAccount} />
      {standard && (
        <section id="receipt" aria-labelledby="receipt-heading" className="card space-y-2">
          <h2 id="receipt-heading" className="font-medium">
            {t('receipts.add_receipt')}
          </h2>
          <p className="text-sm text-muted">{t('receipts.add_receipt_hint')}</p>
          <ReceiptUpload workspaceId={workspaceId} transactionId={transaction.id} compact />
        </section>
      )}
      <section aria-labelledby="journal-heading" className="space-y-3">
        <h2 id="journal-heading" className="text-lg font-semibold">
          {t('journal.title')}
        </h2>
        {entries.length === 0 ? (
          <p className="card text-sm text-muted">
            {transaction.status === 'scheduled' ? t('editor.scheduled_no_entries') : t('editor.no_entries')}
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
