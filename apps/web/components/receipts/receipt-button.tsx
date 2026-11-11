import Link from 'next/link';
import { Plus, Receipt } from 'lucide-react';
import type { TransactionDto } from '@montra/schemas';

export type ReceiptButtonState = 'add' | 'view' | 'reading' | 'check';

/** What the receipt button by a transaction's amount does: open its receipt, or add one. */
export function receiptButtonState(
  receipt: TransactionDto['receipt'],
  canAdd: boolean,
): ReceiptButtonState | null {
  if (receipt)
    return receipt.status === 'processing' ? 'reading' : receipt.status === 'needs_review' ? 'check' : 'view';
  return canAdd ? 'add' : null;
}

const TONE: Record<ReceiptButtonState, string> = {
  view: 'bg-brand-600 text-white hover:bg-brand-700',
  add: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
  reading: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
  check: 'bg-warn/15 text-warn hover:bg-warn/25',
};

/** A round receipt icon: filled when there is a receipt, with a "+" when one can be added. */
export function ReceiptButton({
  state,
  href,
  label,
}: {
  state: ReceiptButtonState;
  href: string;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      data-testid={state === 'add' ? 'txn-add-receipt' : 'txn-receipt'}
      className={`relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${TONE[state]}`}
    >
      <Receipt aria-hidden size={22} />
      {state === 'add' && (
        <span
          aria-hidden
          className="absolute bottom-0.5 right-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 text-white"
        >
          <Plus size={12} strokeWidth={3} />
        </span>
      )}
    </Link>
  );
}
