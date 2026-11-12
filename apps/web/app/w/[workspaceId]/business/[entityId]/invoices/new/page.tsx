import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { InvoiceEditor } from '@/components/business/invoice-editor';

export const metadata: Metadata = { title: 'New invoice' };
export const dynamic = 'force-dynamic';

/** A new invoice (BIZ-05). It gets its number from the business when it's saved. */
export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ customer?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  // A contractor's timesheet links here for the customer its hours were for (ADR-0036 section 5).
  const { customer } = await searchParams;
  const [workspace, business, customers, categories] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getBusiness(workspaceId, entityId),
      api.listParties(workspaceId, { entityId, kind: 'customer' }),
      api.listCategories(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/w/${workspaceId}/business/${entityId}/invoices`} className="text-sm underline">
          ← {t('business.tab_invoices')}
        </Link>
        <h2 className="text-lg font-semibold">{t('invoices.new')}</h2>
      </div>
      <InvoiceEditor
        workspaceId={workspaceId}
        entityId={entityId}
        currency={business.currency}
        customers={customers}
        initialCustomerId={customers.some((c) => c.id === customer) ? customer : undefined}
        incomeCategories={categories.filter((c) => c.entityId === entityId && c.type === 'income')}
        today={todayIn(workspace.timeZone)}
      />
    </div>
  );
}
