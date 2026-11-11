import { describe, expect, it } from 'vitest';
import {
  calendarDate as d,
  employmentStatus,
  i9MayDestroy,
  i9RetainUntil,
  i9Section2Due,
  maskTin,
  hoursPay,
  nextPayPeriod,
  overtimeRate,
  paycheckTotals,
  payPeriodContaining,
  salaryPerPeriod,
} from '../src/index.js';

describe('I-9 retention (3 years after hire or 1 year after leaving, whichever is later)', () => {
  it('has no date while the person is still employed', () => {
    expect(i9RetainUntil(d('2024-03-01'), null)).toBeNull();
  });

  it('uses 3 years after hire for someone who left early', () => {
    // USCIS example: hired and left within the first year, so hire + 3 years is later.
    expect(i9RetainUntil(d('2024-03-01'), d('2024-09-30'))).toBe('2027-03-01');
  });

  it('uses 1 year after leaving for a long-serving employee', () => {
    expect(i9RetainUntil(d('2015-06-15'), d('2026-01-10'))).toBe('2027-01-10');
  });

  it('may be destroyed only after the date has passed', () => {
    expect(i9MayDestroy(d('2027-03-01'), d('2027-03-01'))).toBe(false);
    expect(i9MayDestroy(d('2027-03-01'), d('2027-03-02'))).toBe(true);
    expect(i9MayDestroy(null, d('2040-01-01'))).toBe(false);
  });
});

describe('I-9 Section 2 due date (third business day after the first day)', () => {
  it('is Thursday for a Monday start', () => {
    expect(i9Section2Due(d('2026-11-09'))).toBe('2026-11-12');
  });

  it('skips the weekend', () => {
    expect(i9Section2Due(d('2026-11-12'))).toBe('2026-11-17'); // Thursday → Tuesday
    expect(i9Section2Due(d('2026-11-14'))).toBe('2026-11-18'); // Saturday → Wednesday
  });
});

describe('masking', () => {
  it('masks an SSN and an EIN the way each is written', () => {
    expect(maskTin('ssn', '6789')).toBe('•••-••-6789');
    expect(maskTin('ein', '6789')).toBe('••-•••6789');
    expect(maskTin(null, null)).toBeNull();
  });
});

describe('employment status', () => {
  it('follows the dates', () => {
    const today = d('2026-11-10');
    expect(employmentStatus(d('2026-12-01'), null, today)).toBe('starting');
    expect(employmentStatus(d('2026-01-01'), null, today)).toBe('active');
    expect(employmentStatus(d('2026-01-01'), d('2026-11-10'), today)).toBe('active');
    expect(employmentStatus(d('2026-01-01'), d('2026-11-09'), today)).toBe('ended');
  });
});

describe('pay periods', () => {
  it('counts two-week periods from the anchor, before and after it', () => {
    const anchor = d('2026-01-05');
    expect(payPeriodContaining('biweekly', anchor, d('2026-01-05'))).toEqual({
      start: '2026-01-05',
      end: '2026-01-18',
    });
    expect(payPeriodContaining('biweekly', anchor, d('2026-11-11'))).toEqual({
      start: '2026-11-09',
      end: '2026-11-22',
    });
    expect(payPeriodContaining('biweekly', anchor, d('2026-01-04'))).toEqual({
      start: '2025-12-22',
      end: '2026-01-04',
    });
  });

  it('splits a month in two on the 15th, and handles February', () => {
    expect(payPeriodContaining('semimonthly', d('2026-01-01'), d('2026-02-15'))).toEqual({
      start: '2026-02-01',
      end: '2026-02-15',
    });
    expect(payPeriodContaining('semimonthly', d('2026-01-01'), d('2026-02-16'))).toEqual({
      start: '2026-02-16',
      end: '2026-02-28',
    });
    expect(payPeriodContaining('monthly', d('2026-01-01'), d('2028-02-10'))).toEqual({
      start: '2028-02-01',
      end: '2028-02-29',
    });
  });

  it('moves to the next period', () => {
    const p = payPeriodContaining('semimonthly', d('2026-01-01'), d('2026-12-20'));
    expect(nextPayPeriod('semimonthly', d('2026-01-01'), p)).toEqual({
      start: '2027-01-01',
      end: '2027-01-15',
    });
  });
});

describe('gross to net', () => {
  it('pays a salary per period to the cent, and hours at a rate', () => {
    expect(salaryPerPeriod(5_200_000n, 'biweekly')).toBe(200_000n);
    expect(salaryPerPeriod(5_000_000n, 'semimonthly')).toBe(208_333n); // $2,083.33
    expect(hoursPay(37_500n, 2_250n)).toBe(84_375n);
    expect(hoursPay(1_250n, 1_699n)).toBe(2_124n); // 1.25 h at $16.99 = $21.2375
    expect(overtimeRate(2_250n)).toBe(3_375n);
  });

  it('adds reimbursements to net pay without making them wages, and leaves employer taxes out', () => {
    const t = paycheckTotals([
      { kind: 'earning', amount: 200_000n },
      { kind: 'pre_tax_deduction', amount: 10_000n },
      { kind: 'employee_tax', amount: 30_000n },
      { kind: 'post_tax_deduction', amount: 5_000n },
      { kind: 'reimbursement', amount: 4_250n },
      { kind: 'employer_tax', amount: 15_300n },
    ]);
    expect(t).toEqual({
      gross: 200_000n,
      preTax: 10_000n,
      employeeTaxes: 30_000n,
      postTax: 5_000n,
      reimbursements: 4_250n,
      net: 159_250n,
      employerTaxes: 15_300n,
    });
  });
});
