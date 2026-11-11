import { describe, expect, it } from 'vitest';
import {
  addBankingDays,
  caSdi,
  caUiEtt,
  caWithholding,
  caWithholdingFor,
  depositPeriod,
  divRound,
  employmentTaxWages,
  federalHolidays,
  federalWithholding,
  fica,
  futa,
  incomeTaxWages,
  payrollTaxYear,
  quarterlyDue,
  type CalendarDate,
  type De4Figures,
  type W4Figures,
} from '../src/index.js';

const t = payrollTaxYear(2026)!;
const d = (s: string) => s as CalendarDate;
const w4 = (over: Partial<W4Figures> = {}): W4Figures => ({
  filingStatus: 'single',
  multipleJobs: false,
  dependents: 0n,
  otherIncome: 0n,
  deductions: 0n,
  extraWithholding: 0n,
  exempt: false,
  ...over,
});
const de4 = (over: Partial<De4Figures> = {}): De4Figures => ({
  filingStatus: 'single',
  allowances: 0,
  estimatedDeductionAllowances: 0,
  extraWithholding: 0n,
  exempt: false,
  ...over,
});

describe('federal income tax withholding (Pub 15-T 2026, Worksheet 1A)', () => {
  it('has no tables for a year Montra has not transcribed', () => {
    expect(payrollTaxYear(2025)).toBeNull();
  });

  it('single, biweekly $2,000, nothing else on the W-4', () => {
    // 1c 52,000; 1g 8,600; 1i 43,400. Over 19,900: 1,240 + 12% × 23,500 = 4,060. 2h 4,060 / 26 = 156.15.
    expect(federalWithholding(t, 200_000n, 26, w4())).toEqual({
      annualWages: 5_200_000n,
      adjustedAnnualWages: 4_340_000n,
      tentative: 15_615n,
      credit: 0n,
      withholding: 15_615n,
    });
  });

  it('married filing jointly, monthly $10,000, $4,000 of dependents and $50 extra', () => {
    // 1i 120,000 − 12,900 = 107,100. Over 44,100: 2,480 + 12% × 63,000 = 10,040; / 12 = 836.67.
    // 3b 4,000 / 12 = 333.33. 3c 503.34; 4b + 50 = 553.34.
    const r = federalWithholding(
      t,
      1_000_000n,
      12,
      w4({ filingStatus: 'married_jointly', dependents: 400_000n, extraWithholding: 5_000n }),
    );
    expect(r).toMatchObject({ adjustedAnnualWages: 10_710_000n, tentative: 83_667n, credit: 33_333n });
    expect(r.withholding).toBe(55_334n);
  });

  it('head of household with Step 2 checked uses the higher schedule and no line 1g allowance', () => {
    // 1i 72,000. Step 2 HoH over 64,925: 8,077.50 + 24% × 7,075 = 9,775.50; / 24 = 407.31.
    expect(
      federalWithholding(t, 300_000n, 24, w4({ filingStatus: 'head_of_household', multipleJobs: true }))
        .withholding,
    ).toBe(40_731n);
  });

  it('adds Step 4(a) income and takes off Step 4(b) deductions, never below zero', () => {
    // 1i 26,000 + 5,000 − 20,000 − 8,600 = 2,400: under 7,500, nothing.
    expect(
      federalWithholding(t, 100_000n, 26, w4({ otherIncome: 500_000n, deductions: 2_000_000n })).withholding,
    ).toBe(0n);
    // A credit larger than the tax leaves only the extra withholding.
    expect(
      federalWithholding(t, 100_000n, 26, w4({ dependents: 1_000_000n, extraWithholding: 2_500n }))
        .withholding,
    ).toBe(2_500n);
  });

  it('withholds nothing from an exempt employee, and treats a missing W-4 as single', () => {
    expect(federalWithholding(t, 500_000n, 26, w4({ exempt: true })).withholding).toBe(0n);
    expect(federalWithholding(t, 200_000n, 26, null).withholding).toBe(15_615n);
  });
});

describe('Social Security, Medicare and FUTA (2026)', () => {
  it('stops Social Security at the $184,500 wage base', () => {
    const r = fica(t, 1_000_000n, 18_000_000n);
    expect(r.ssWages).toBe(450_000n);
    expect(r.ss).toBe(27_900n);
    expect(r.ssEmployer).toBe(27_900n);
    expect(fica(t, 1_000_000n, 18_450_000n).ss).toBe(0n);
  });

  it('withholds Additional Medicare only on wages over $200,000, with no employer share', () => {
    // Paid $195,000 so far and $10,000 now: 0.9% of $5,000 (Pub 15 §9).
    const r = fica(t, 1_000_000n, 19_500_000n);
    expect(r.addlMedicareWages).toBe(500_000n);
    expect(r.addlMedicare).toBe(4_500n);
    expect(r.medicare).toBe(14_500n);
    expect(r.medicareEmployer).toBe(14_500n);
    expect(fica(t, 1_000_000n, 0n).addlMedicare).toBe(0n);
  });

  it('rounds each tax to the cent, half up', () => {
    // 6.2% of $1,234.56 = 76.54272; 1.45% = 17.90112.
    const r = fica(t, 123_456n, 0n);
    expect(r.ss).toBe(7_654n);
    expect(r.medicare).toBe(1_790n);
  });

  it('owes FUTA at 0.6% on the first $7,000', () => {
    expect(futa(t, 100_000n, 650_000n)).toEqual({ wages: 50_000n, tax: 300n });
    expect(futa(t, 100_000n, 700_000n)).toEqual({ wages: 0n, tax: 0n });
  });

  it('leaves 401(k) deferrals in employment-tax wages and takes cafeteria-plan deductions out of both', () => {
    const w = { gross: 300_000n, retirement: 30_000n, section125: 20_000n };
    expect(incomeTaxWages(w)).toBe(250_000n);
    expect(employmentTaxWages(w)).toBe(280_000n);
  });
});

describe('California withholding (EDD 2026, Method B)', () => {
  it('Example A: under the low-income exemption, nothing is withheld', () => {
    // Weekly $210 single is under $363; the biweekly equivalent is under $727.
    const r = caWithholding(t, 'biweekly', 42_000n, de4({ allowances: 1 }));
    expect(r).toMatchObject({ lowIncome: true, withholding: 0n });
  });

  it('Example B: biweekly $1,600, married, three allowances of which one for estimated deductions', () => {
    const r = caWithholding(
      t,
      'biweekly',
      160_000n,
      de4({ filingStatus: 'married', allowances: 2, estimatedDeductionAllowances: 1 }),
    );
    expect(r).toEqual({
      lowIncome: false,
      wagesSubject: 156_200n,
      taxable: 112_300n,
      computedTax: 1_533n,
      credit: 1_295n,
      withholding: 238n,
    });
  });

  it('Example C: monthly $5,100, married, five allowances', () => {
    const r = caWithholding(t, 'monthly', 510_000n, de4({ filingStatus: 'married', allowances: 5 }));
    expect(r).toMatchObject({ taxable: 414_900n, computedTax: 7_095n, credit: 7_013n, withholding: 82n });
  });

  it('Examples E and F: the annual tables, divided by the payroll periods', () => {
    const married4 = de4({ filingStatus: 'married', allowances: 4 });
    const e = caWithholdingFor(t.california.periods.annual, 5_760_000n, married4);
    expect(e).toMatchObject({
      taxable: 4_618_800n,
      computedTax: 77_240n,
      credit: 67_320n,
      withholding: 9_920n,
    });
    expect(divRound(e.withholding, 24n)).toBe(413n);
    const f = caWithholdingFor(t.california.periods.annual, 5_700_000n, married4);
    expect(f.withholding).toBe(8_600n);
    expect(divRound(f.withholding, 12n)).toBe(717n);
  });

  it('uses the married 0-or-1 column for a married employee with one allowance', () => {
    // Monthly $2,000: over the $1,575 low-income limit for that column, standard deduction $476.
    const r = caWithholding(t, 'monthly', 200_000n, de4({ filingStatus: 'married', allowances: 1 }));
    expect(r.lowIncome).toBe(false);
    expect(r.taxable).toBe(152_400n);
  });

  it('withholds as single with no allowances when there is no DE 4, adds the extra, and honours exempt', () => {
    // Biweekly $3,000 single: 3,000 − 219 = 2,781. Over 2,214: 84.16 + 8.8% × 567 = 134.06.
    expect(caWithholding(t, 'biweekly', 300_000n, null).withholding).toBe(13_406n);
    expect(caWithholding(t, 'biweekly', 300_000n, de4({ extraWithholding: 1_000n })).withholding).toBe(
      14_406n,
    );
    expect(caWithholding(t, 'biweekly', 300_000n, de4({ exempt: true })).withholding).toBe(0n);
  });

  it('multiplies the one-allowance amounts beyond ten', () => {
    // Weekly table's 15-allowance example is 15 × 3.24; on the biweekly table, 12 allowances are 12 × 6.47.
    const r = caWithholding(t, 'biweekly', 1_000_000n, de4({ filingStatus: 'married', allowances: 12 }));
    expect(r.credit).toBe(7_764n);
  });

  it('SDI at 1.3% with no wage limit; UI at the business rate and ETT at 0.1% on the first $7,000', () => {
    expect(caSdi(t, 1_000_000n, 50_000_000n)).toEqual({ wages: 1_000_000n, tax: 13_000n });
    expect(caUiEtt(t, 200_000n, 600_000n, t.california.newEmployerUiRate, t.california.ettRate)).toEqual({
      wages: 100_000n,
      ui: 3_400n,
      ett: 100n,
    });
  });
});

describe('deposit due dates', () => {
  it('knows 2026’s federal holidays as observed', () => {
    const h = federalHolidays(2026);
    expect(h).toContain('2026-07-03'); // July 4 is a Saturday
    expect(h).toContain('2026-02-16');
    expect(h).toContain('2026-11-26');
    expect(h).toContain('2026-04-16');
    expect(federalHolidays(2021)).toContain('2021-12-31'); // January 1, 2022 was a Saturday
  });

  it('monthly: the 15th of the next month, moved past weekends and holidays', () => {
    expect(depositPeriod('monthly', d('2026-03-20'))).toEqual({
      start: '2026-03-01',
      end: '2026-03-31',
      due: '2026-04-15',
    });
    // February 15, 2026 is a Sunday and the 16th is Presidents' Day.
    expect(depositPeriod('monthly', d('2026-01-30')).due).toBe('2026-02-17');
  });

  it('semiweekly: Wednesday to Friday paydays the next Wednesday, Saturday to Tuesday the next Friday', () => {
    expect(depositPeriod('semiweekly', d('2026-11-13'))).toEqual({
      start: '2026-11-11',
      end: '2026-11-13',
      due: '2026-11-18',
    });
    // Thanksgiving falls in the three banking days, so a day is added.
    expect(depositPeriod('semiweekly', d('2026-11-24'))).toEqual({
      start: '2026-11-21',
      end: '2026-11-24',
      due: '2026-11-30',
    });
  });

  it('semiweekly: a period never spans two quarters', () => {
    expect(depositPeriod('semiweekly', d('2026-09-30'))).toEqual({
      start: '2026-09-30',
      end: '2026-09-30',
      due: '2026-10-07',
    });
    expect(depositPeriod('semiweekly', d('2026-10-02')).start).toBe('2026-10-01');
  });

  it('quarterly: the last day of the month after the quarter', () => {
    expect(quarterlyDue(2026, 1)).toBe('2026-04-30');
    expect(quarterlyDue(2026, 4)).toBe('2027-02-01'); // January 31, 2027 is a Sunday
    expect(depositPeriod('quarterly', d('2026-05-05'))).toEqual({
      start: '2026-04-01',
      end: '2026-06-30',
      due: '2026-07-31',
    });
    expect(addBankingDays(d('2026-12-24'), 1)).toBe('2026-12-28');
  });
});
