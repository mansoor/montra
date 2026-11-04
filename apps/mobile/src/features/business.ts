/**
 * The business on the phone (08 §3): what's owed either way, and logging a trip. The numbers all come from the server,
 * and no ledger or tax logic lives here; invoices and bills are written on the web.
 */
import type { BillDto, InvoiceDto } from '@montra/schemas';

const OPEN_INVOICE: readonly InvoiceDto['status'][] = ['sent', 'partial', 'overdue'];
const OPEN_BILL: readonly BillDto['status'][] = ['open', 'overdue'];

/** What customers still owe, most overdue first. */
export function openInvoices(list: readonly InvoiceDto[]): InvoiceDto[] {
  return list
    .filter((i) => OPEN_INVOICE.includes(i.status))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

/** Bills still to pay, soonest first. */
export function openBills(list: readonly BillDto[]): BillDto[] {
  return list
    .filter((b) => OPEN_BILL.includes(b.status))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

export const sumMinor = (values: readonly string[]): bigint => values.reduce((t, v) => t + BigInt(v), 0n);

/** Miles as the API takes them: digits and at most one decimal. Null when it isn't that. */
export function normalizeMiles(input: string): string | null {
  const t = input.trim();
  return /^\d{1,6}(\.\d)?$/.test(t) && /[1-9]/.test(t) ? t : null;
}
