import { describe, expect, it } from 'vitest';
import {
  dollarsToMinor,
  hoursLabel,
  payslipSections,
  signedAmount,
  signedHoursLabel,
  trackedBalances,
} from '../src/features/payroll';

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

describe('leave balances on the phone (PRL-25)', () => {
  const balance = (kind: 'vacation' | 'sick', tracked: boolean, balanceMilli: string) => ({
    kind,
    tracked,
    method: 'accrual' as const,
    balanceMilli,
    usedThisYearMilli: '0',
    accruedThisYearMilli: '0',
  });

  it('keeps the sign of a balance used past zero', () => {
    expect(signedHoursLabel('-5600')).toBe('-5.6');
    expect(signedHoursLabel('2400')).toBe('2.4');
  });

  it('shows only the kinds tracked for the person', () => {
    expect(trackedBalances([balance('vacation', false, '0'), balance('sick', true, '2400')])).toEqual([
      balance('sick', true, '2400'),
    ]);
  });
});
