import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TYPES,
  calendarDate,
  electsSCorp,
  filesScheduleC,
  fiscalYearOf,
  fiscalYearRange,
  maskId,
  ownerEmployeeNote,
  returnFormOf,
  renewalDue,
} from '../src/index.js';

describe('entity types (BIZ-21)', () => {
  it('maps each type to the federal return it files', () => {
    expect(BUSINESS_TYPES.map((t) => [t, returnFormOf(t)])).toEqual([
      ['sole_prop', 'schedule_c'],
      ['single_member_llc', 'schedule_c'],
      ['single_member_llc_s_corp', 'form_1120s'],
      ['multi_member_llc', 'form_1065'],
      ['multi_member_llc_s_corp', 'form_1120s'],
      ['partnership', 'form_1065'],
      ['s_corp', 'form_1120s'],
      ['c_corp', 'form_1120'],
    ]);
  });

  it('assumes Schedule C when the type does not say, as before', () => {
    for (const t of [null, undefined, 'llc', 'other']) {
      expect(returnFormOf(t)).toBeNull();
      expect(filesScheduleC(t)).toBe(true);
    }
    expect(filesScheduleC('partnership')).toBe(false);
  });

  it('asks for an S-corp election date only for the S-corp types', () => {
    expect(BUSINESS_TYPES.filter(electsSCorp)).toEqual([
      'single_member_llc_s_corp',
      'multi_member_llc_s_corp',
      's_corp',
    ]);
  });
});

describe('the owner on payroll (BIZ-25)', () => {
  it('warns a sole proprietor and a single-member LLC taxed as one', () => {
    expect(ownerEmployeeNote('sole_prop')).toBe('not_an_employee_draws');
    expect(ownerEmployeeNote('single_member_llc')).toBe('not_an_employee_draws');
  });
  it('tells partners they take guaranteed payments', () => {
    expect(ownerEmployeeNote('partnership')).toBe('not_an_employee_partner');
    expect(ownerEmployeeNote('multi_member_llc')).toBe('not_an_employee_partner');
  });
  it('reminds an S-corp owner of a reasonable salary', () => {
    expect(ownerEmployeeNote('s_corp')).toBe('reasonable_salary');
    expect(ownerEmployeeNote('single_member_llc_s_corp')).toBe('reasonable_salary');
    expect(ownerEmployeeNote('multi_member_llc_s_corp')).toBe('reasonable_salary');
  });
  it('says nothing for a C-corp or an unknown type', () => {
    expect(ownerEmployeeNote('c_corp')).toBeNull();
    expect(ownerEmployeeNote('llc')).toBeNull();
    expect(ownerEmployeeNote(null)).toBeNull();
  });
});

describe('fiscal year (BIZ-21)', () => {
  it('is the calendar year when it starts in January', () => {
    expect(fiscalYearRange(2026, 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('runs to the day before the start month a year later', () => {
    expect(fiscalYearRange(2026, 7)).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    expect(fiscalYearRange(2027, 3)).toEqual({ from: '2027-03-01', to: '2028-02-29' });
  });
  it('names a date by the year its fiscal year began', () => {
    expect(fiscalYearOf(calendarDate('2026-11-11'), 7)).toBe(2026);
    expect(fiscalYearOf(calendarDate('2026-06-30'), 7)).toBe(2025);
    expect(fiscalYearOf(calendarDate('2026-01-01'), 1)).toBe(2026);
  });
});

describe('renewals and masking (BIZ-24, BIZ-26)', () => {
  it('is due 30 days before expiry, and after', () => {
    const exp = calendarDate('2026-12-31');
    expect(renewalDue(exp, calendarDate('2026-11-30'))).toBe(false);
    expect(renewalDue(exp, calendarDate('2026-12-01'))).toBe(true);
    expect(renewalDue(exp, calendarDate('2027-01-05'))).toBe(true);
  });
  it('shows only the last four', () => {
    expect(maskId('123456789', 'ein')).toBe('••-•••6789');
    expect(maskId('12345678')).toBe('••••5678');
    expect(maskId('123')).toBe('••123');
    expect(maskId(null)).toBeNull();
  });
});
