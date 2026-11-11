/**
 * Payroll on the phone (PRL-22): pay runs and payslips to look at, and a reimbursement with a receipt photo to submit.
 * Pay and tax figures all come from the server; this only groups and formats them.
 */
import type { PaycheckDto } from '@montra/schemas';

export type PayslipSection =
  'earning' | 'pre_tax_deduction' | 'employee_tax' | 'post_tax_deduction' | 'reimbursement' | 'employer_tax';

const ORDER: readonly PayslipSection[] = [
  'earning',
  'pre_tax_deduction',
  'employee_tax',
  'post_tax_deduction',
  'reimbursement',
  'employer_tax',
];

/** A paycheck's lines grouped the way a payslip reads, skipping empty groups. */
export function payslipSections(pc: Pick<PaycheckDto, 'lines'>) {
  return ORDER.map((section) => ({ section, lines: pc.lines.filter((l) => l.kind === section) })).filter(
    (g) => g.lines.length > 0,
  );
}

/** What a line takes from or adds to pay: deductions and withheld taxes show as negative. */
export const signedAmount = (kind: PayslipSection, amount: string): string =>
  kind === 'pre_tax_deduction' || kind === 'employee_tax' || kind === 'post_tax_deduction'
    ? amount === '0'
      ? '0'
      : `-${amount}`
    : amount;

/** "12.5" or "1,234.56" dollars → minor units; null when it isn't a positive amount with at most two decimals. */
export function dollarsToMinor(input: string): string | null {
  const t = input.trim().replace(/,/g, '');
  const m = t.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const minor = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return minor > 0n ? String(minor) : null;
}

/** "37500" thousandths of an hour → "37.5". */
export function hoursLabel(milli: string): string {
  const n = BigInt(milli);
  const frac = (n % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${n / 1000n}.${frac}` : String(n / 1000n);
}
