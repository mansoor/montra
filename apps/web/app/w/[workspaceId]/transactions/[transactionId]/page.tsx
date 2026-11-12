import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { AllocatePanel } from '@/components/rentals/rental-ops';
import { TransactionEditor } from '@/components/transaction-editor';
import { JournalView } from '@/components/journal-view';
import { TransactionFx } from '@/components/receipts/transaction-fx';
import { ReceiptUpload } from '@/components/receipts/receipt-upload';
import { ReceiptButton, receiptButtonState } from '@/components/receipts/receipt-button';
import { ExpenseDetailPanel } from '@/components/business/expense-detail';

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
  // RNT-06, RNT-07: properties to tag or split this across, in the books its category is in.
  const portfolios = workspace.entities.filter((e) => e.type === 'rental');
  const [properties, allocationRules] = await load((api) =>
    Promise.all([
      Promise.all(portfolios.map((e) => api.listProperties(workspaceId, e.id))),
      Promise.all(portfolios.map((e) => api.listAllocationRules(workspaceId, e.id))),
    ]),
  );
  const allProperties = properties.flat();
  // BIZ-18: who spent and, for a meal, who was there and why. Payroll people need write access to the business.
  const detail = transaction.expenseDetail;
  const [people, parties] = detail
    ? await load((api) =>
        Promise.all([
          api.listPayrollPeople(workspaceId, { entityId: detail.entityId }).catch(() => []),
          api.listParties(workspaceId, { entityId: detail.entityId }).catch(() => []),
        ]),
      )
    : [[], []];
  const splitEntity = categories.find((c) => c.id === transaction.splits?.[0]?.accountId)?.entityId;
  const canAllocate =
    transaction.amount !== null &&
    transaction.splits !== null &&
    !transaction.managedBy &&
    portfolios.some((e) => e.id === splitEntity);
  const { t, money } = await getI18n();
  const entityName = new Map(workspace.entities.map((e) => [e.id, e.name]));
  // CUR-05: rates apply when the paying account's currency differs from its entity's.
  const account = accounts.find((a) => a.id === transaction.accountId);
  const functional = workspace.entities.find((e) => e.id === account?.entityId)?.functionalCurrency;
  const foreignAccount = Boolean(account && functional && account.currency !== functional);
  const standard = transaction.entries.some((e) => e.kind === 'standard') && transaction.amount !== null;
  // The receipt by the amount: opens it, or goes to "Add a receipt" below.
  const receiptState = receiptButtonState(transaction.receipt, standard && !transaction.managedBy);
  const RECEIPT_LABEL = {
    add: 'receipts.add_receipt',
    view: 'receipts.view_receipt',
    reading: 'receipts.reading_receipt',
    check: 'receipts.receipt_needs_look',
  } as const;
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
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title min-w-0 flex-1">
          {transaction.payee || transaction.description || t('editor.untitled')}
        </h1>
        {transaction.amount && (
          <span className="num text-xl font-semibold" data-testid="txn-amount">
            {money(transaction.amount.amount, transaction.amount.currency)}
          </span>
        )}
        {receiptState && (
          <ReceiptButton
            state={receiptState}
            label={t(RECEIPT_LABEL[receiptState])}
            href={
              transaction.receipt
                ? `/w/${workspaceId}/receipts/${transaction.receipt.id}`
                : `/w/${workspaceId}/transactions/${transaction.id}#receipt`
            }
          />
        )}
      </div>
      <TransactionEditor
        workspace={workspace}
        transaction={transaction}
        accounts={accounts}
        categories={categories}
        members={members}
        properties={allProperties}
      />
      {canAllocate && (
        <AllocatePanel
          workspaceId={workspaceId}
          transactionId={transaction.id}
          properties={allProperties.filter((p) => p.entityId === splitEntity && !p.archived)}
          rules={allocationRules.flat().filter((r) => r.entityId === splitEntity)}
        />
      )}
      {hints.map((line) => (
        <p key={line.code} className="text-sm text-muted" data-testid="tax-hint">
          {t(line.form === 'schedule_c' ? 'tax_hint.schedule_c' : 'tax_hint.schedule_e', {
            line: line.line,
            label: line.label,
          })}
          {line.deductibleBps < 10000 && ` ${t('tax_hint.partly', { percent: line.deductibleBps / 100 })}`}
        </p>
      ))}
      {detail && (
        <ExpenseDetailPanel
          workspaceId={workspaceId}
          transactionId={transaction.id}
          detail={detail}
          people={people.map((p) => ({ id: p.id, name: p.displayName }))}
          parties={parties.flatMap((p) => (p.id ? [{ id: p.id, name: p.name }] : []))}
          canEdit={workspace.role !== 'viewer'}
        />
      )}
      <TransactionFx workspaceId={workspaceId} transaction={transaction} foreignAccount={foreignAccount} />
      {receiptState === 'add' && (
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
