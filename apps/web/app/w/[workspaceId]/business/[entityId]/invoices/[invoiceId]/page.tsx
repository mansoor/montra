import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { INVOICE_CHIP } from '@/lib/business';
import { InvoiceActions } from '@/components/business/invoice-actions';
import { InvoiceEditor } from '@/components/business/invoice-editor';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';

export const metadata: Metadata = { title: 'Invoice' };
export const dynamic = 'force-dynamic';

/** One invoice: editable as a draft, a record once sent (BIZ-05). */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string; invoiceId: string }>;
}) {
  const { workspaceId, entityId, invoiceId } = await params;
  const [workspace, business, invoice, customers, categories, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getBusiness(workspaceId, entityId),
      api.getInvoice(workspaceId, invoiceId),
      api.listParties(workspaceId, { entityId, kind: 'customer' }),
      api.listCategories(workspaceId),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const today = todayIn(workspace.timeZone);
  const customer = customers.find((c) => c.id === invoice.partyId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/business/${entityId}/invoices`} className="text-sm underline">
          ← {t('business.tab_invoices')}
        </Link>
        <h2 className="text-lg font-semibold">{invoice.number}</h2>
        <span className={INVOICE_CHIP[invoice.status]} data-testid="invoice-status">
          {t(`invoices.status.${invoice.status}`)}
        </span>
      </div>
      {invoice.status === 'draft' ? (
        <InvoiceEditor
          workspaceId={workspaceId}
          entityId={entityId}
          currency={business.currency}
          customers={customers}
          incomeCategories={categories.filter((c) => c.entityId === entityId && c.type === 'income')}
          today={today}
          invoice={invoice}
        />
      ) : (
        <section className="card space-y-3" aria-label={t('invoices.details')}>
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted">{t('invoices.customer')}</dt>
              <dd className="font-medium">{invoice.partyName}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('invoices.issue_date')}</dt>
              <dd>
                <DateText date={invoice.issueDate} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t('invoices.due_date')}</dt>
              <dd>
                <DateText date={invoice.dueDate} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t('invoices.open_amount')}</dt>
              <dd className="font-semibold">
                <Money amount={invoice.open} currency={invoice.currency} />
              </dd>
            </div>
          </dl>
          <table className="tbl text-sm">
            <thead>
              <tr>
                <th className="py-1">{t('invoices.description')}</th>
                <th className="py-1 text-right">{t('invoices.quantity')}</th>
                <th className="py-1 text-right">{t('invoices.price')}</th>
                <th className="py-1 text-right">{t('invoices.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoice.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-1.5">{l.description}</td>
                  <td className="num py-1.5 text-right">{l.quantity}</td>
                  <td className="py-1.5 text-right">
                    <Money amount={l.unitPrice} currency={invoice.currency} />
                  </td>
                  <td className="py-1.5 text-right">
                    <Money amount={l.amount} currency={invoice.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ml-auto max-w-xs space-y-1 border-t border-line pt-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt>{t('invoices.subtotal')}</dt>
              <dd>
                <Money amount={invoice.subtotal} currency={invoice.currency} />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>{t('invoices.tax')}</dt>
              <dd>
                <Money amount={invoice.tax} currency={invoice.currency} />
              </dd>
            </div>
            <div className="flex justify-between gap-4 font-semibold">
              <dt>{t('invoices.total')}</dt>
              <dd>
                <Money amount={invoice.total} currency={invoice.currency} />
              </dd>
            </div>
          </dl>
        </section>
      )}
      <InvoiceActions
        workspaceId={workspaceId}
        invoice={invoice}
        accounts={accounts.filter((a) => !a.archived)}
        defaultAccountId={business.defaultDepositAccountId}
        customerEmail={customer?.email ?? null}
        today={today}
      />
    </div>
  );
}
