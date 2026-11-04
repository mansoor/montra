/**
 * Payslips on the phone (PAY-03): capture, check and confirm. The numbers come from the server and nothing is
 * stored on the device, because payslips are private (PAY-09). Amounts are corrected on the web review screen.
 */
import type { PayslipDto, PayslipLineDto, PayslipSection } from '@montra/schemas';

const ORDER: readonly PayslipSection[] = ['earning', 'pre_tax', 'tax', 'post_tax', 'employer'];

/** The sections that have lines, in the order a payslip prints them. */
export function linesBySection(
  p: Pick<PayslipDto, 'lines'>,
): { section: PayslipSection; lines: PayslipLineDto[] }[] {
  return ORDER.map((section) => ({
    section,
    lines: p.lines.filter((l) => l.section === section).sort((a, b) => a.lineNo - b.lineNo),
  })).filter((g) => g.lines.length > 0);
}

/** A payslip posts only when it's dated and adds up; the API enforces both, so this only hides the button. */
export const canConfirm = (p: Pick<PayslipDto, 'status' | 'payDate' | 'gap' | 'lines'>): boolean =>
  p.status === 'needs_review' && p.payDate !== null && p.gap === '0' && p.lines.length > 0;
