import { describe, expect, it } from 'vitest';
import { dollarsToMinor, hoursLabel, payslipSections, signedAmount } from '../src/features/payroll';

const line = (kind: string, amount: string) => ({
  id: kind + amount,
  kind: kind as never,
  code: 'x',
  label: kind,
  hoursMilli: null,
  rate: null,
  amount,
  taxable: null,
  source: 'manual' as const,
  reimbursementId: null,
});

describe('payslips on the phone', () => {
  it('groups lines the way a payslip reads, skipping empty groups', () => {
    const groups = payslipSections({
      lines: [line('employee_tax', '100'), line('earning', '1000'), line('reimbursement', '20')],
    });
    expect(groups.map((g) => g.section)).toEqual(['earning', 'employee_tax', 'reimbursement']);
  });

  it('shows withheld amounts as negative', () => {
    expect(signedAmount('employee_tax', '1500')).toBe('-1500');
    expect(signedAmount('reimbursement', '1500')).toBe('1500');
    expect(signedAmount('pre_tax_deduction', '0')).toBe('0');
  });

  it('reads an amount in dollars', () => {
    expect(dollarsToMinor('24')).toBe('2400');
    expect(dollarsToMinor('1,234.5')).toBe('123450');
    expect(dollarsToMinor('0')).toBeNull();
    expect(dollarsToMinor('1.234')).toBeNull();
    expect(dollarsToMinor('-5')).toBeNull();
  });

  it('writes hours', () => {
    expect(hoursLabel('80000')).toBe('80');
    expect(hoursLabel('37500')).toBe('37.5');
  });
});
