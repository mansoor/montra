import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ReceiptReview } from '@/components/receipts/receipt-review';

export const metadata: Metadata = { title: 'Receipt' };
export const dynamic = 'force-dynamic';

/** Review one receipt: the image beside its lines (RCP-06). */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ workspaceId: string; receiptId: string }>;
}) {
  const { workspaceId, receiptId } = await params;
  const [workspace, receipt, categories, members, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getReceipt(workspaceId, receiptId),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/receipts`} className="text-sm underline">
          {t('receipts.back')}
        </Link>
        <h1 className="text-xl font-semibold">{receipt.merchant ?? t('receipts.unknown_merchant')}</h1>
      </div>
      <ReceiptReview
        workspace={workspace}
        receipt={receipt}
        categories={categories}
        members={members.filter((m) => m.status === 'active')}
        accounts={accounts.filter((a) => !a.archived)}
      />
    </div>
  );
}
