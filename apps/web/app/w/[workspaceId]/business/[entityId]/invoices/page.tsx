import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { INVOICE_CHIP } from '@/lib/business';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { EmptyState } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

/** Invoices (BIZ-05). */
export default async function InvoicesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const invoices = await load((api) => api.listInvoices(workspaceId, { entityId }));
  const { t } = await getI18n();
  const base = `/w/${workspaceId}/business/${entityId}/invoices`;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Link href={`${base}/new`} className="btn-primary">
          {t('invoices.new')}
        </Link>
      </div>
      {invoices.length === 0 ? (
        <EmptyState title={t('invoices.empty')} />
      ) : (
        <section className="card-flush" aria-label={t('business.tab_invoices')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('invoices.number')}</th>
                <th className="px-2 py-2">{t('invoices.customer')}</th>
                <th className="px-2 py-2">{t('invoices.due_date')}</th>
                <th className="px-2 py-2 text-right">{t('invoices.total')}</th>
                <th className="px-2 py-2 text-right">{t('invoices.open_amount')}</th>
                <th className="px-4 py-2">{t('invoices.status_col')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoices.map((i) => (
                <tr key={i.id} data-testid="invoice-row">
                  <td className="px-4 py-2">
                    <Link href={`${base}/${i.id}`} className="font-medium underline">
                      {i.number}
                    </Link>
                  </td>
                  <td className="px-2 py-2">{i.partyName}</td>
                  <td className="px-2 py-2">
                    <DateText date={i.dueDate} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={i.total} currency={i.currency} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money amount={i.open} currency={i.currency} />
                  </td>
                  <td className="px-4 py-2">
                    <span className={INVOICE_CHIP[i.status]}>{t(`invoices.status.${i.status}`)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
