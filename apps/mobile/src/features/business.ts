/**
 * The business on the phone (08 §3): what's owed either way, and logging a trip. The numbers all come from the server,
 * and no ledger or tax logic lives here; invoices and bills are written on the web.
 */
import type { BillDto, ExpenseDetailDto, InvoiceDto } from '@montra/schemas';

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

/** A file name for an invoice's PDF on the device: its number, with nothing a file system would choke on. */
export function invoicePdfName(number: string): string {
  const safe = number.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '');
  return `${safe || 'invoice'}.pdf`;
}

/**
 * What the transaction screen shows of a business expense's details (BIZ-18): who spent, who was at a meal and why, and
 * whether the IRS hint applies. Read-only on the phone; they're entered on the web. Null when there's nothing to show.
 */
export function expenseLines(
  d: ExpenseDetailDto | null | undefined,
): { spentBy: string | null; attendees: string | null; purpose: string | null; mealHint: boolean } | null {
  if (!d) return null;
  const spentBy = d.spentBy === 'owner' ? 'owner' : d.spentBy === 'person' ? (d.spentByName ?? '') : null;
  const attendees = d.attendees.length ? d.attendees.map((a) => a.name).join(', ') : null;
  const out = { spentBy, attendees, purpose: d.businessPurpose, mealHint: d.needsMealDetail };
  return spentBy || attendees || out.purpose || out.mealHint ? out : null;
}

/** The dashboard's months for the table, newest first. */
export function newestFirst<T extends { start: string }>(months: readonly T[]): T[] {
  return [...months].sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
}
