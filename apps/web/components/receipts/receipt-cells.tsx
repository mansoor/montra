'use client';

import type { ReceiptDto } from '@montra/api-client';
import { receiptTotal } from '@/lib/receipts';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';

export function ReceiptDate({ receipt }: { receipt: ReceiptDto }) {
  const { t } = useI18n();
  return receipt.receiptDate ? (
    <DateText date={receipt.receiptDate} />
  ) : (
    <span className="text-muted">{t('receipts.no_date')}</span>
  );
}

export function ReceiptAmount({ receipt }: { receipt: ReceiptDto }) {
  const total = receiptTotal(receipt);
  return total ? (
    <Money amount={total.amount} currency={total.currency} />
  ) : (
    <span className="text-muted">—</span>
  );
}
