import type { Metadata } from 'next';
import { canSpendFrom, todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { BillManager } from '@/components/business/bill-manager';

export const metadata: Metadata = { title: 'Bills' };
export const dynamic = 'force-dynamic';

/** Bills to pay (BIZ-06). */
export default async function BillsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, business, bills, vendors, categories, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getBusiness(workspaceId, entityId),
      api.listBills(workspaceId, { entityId }),
      api.listParties(workspaceId, { entityId, kind: 'vendor' }),
      api.listCategories(workspaceId),
      api.listAccounts(workspaceId),
    ]),
  );
  return (
    <BillManager
      workspaceId={workspaceId}
      entityId={entityId}
      currency={business.currency}
      bills={bills}
      vendors={vendors}
      expenseCategories={categories.filter((c) => c.entityId === entityId && c.type === 'expense')}
      accounts={accounts.filter(canSpendFrom)}
      defaultAccountId={business.defaultDepositAccountId}
      today={todayIn(workspace.timeZone)}
    />
  );
}
