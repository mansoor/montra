import type { Metadata } from 'next';
import Link from 'next/link';
import { canSpendFrom } from '@montra/domain';
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
        <h1 className="page-title">{receipt.merchant ?? t('receipts.unknown_merchant')}</h1>
      </div>
      {(receipt.storeAddress || receipt.storePhone || receipt.storeWebsite) && (
        // The store's details as printed on the receipt (RCP-01).
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="store-details">
          {receipt.storeAddress && (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(receipt.storeAddress)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              title={t('receipts.store.map')}
            >
              {receipt.storeAddress}
            </a>
          )}
          {receipt.storePhone && (
            <a
              href={`tel:${receipt.storePhone.replace(/[^\d+]/g, '')}`}
              className="underline"
              title={t('receipts.store.call')}
            >
              {receipt.storePhone}
            </a>
          )}
          {receipt.storeWebsite && (
            <a
              href={`https://${receipt.storeWebsite}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              title={t('receipts.store.website')}
            >
              {receipt.storeWebsite}
            </a>
          )}
        </p>
      )}
      <ReceiptReview
        workspace={workspace}
        receipt={receipt}
        categories={categories}
        members={members.filter((m) => m.status === 'active')}
        accounts={accounts.filter(canSpendFrom)}
      />
    </div>
  );
}
