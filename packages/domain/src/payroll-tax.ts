/**
 * Payroll tax arithmetic: federal income tax withholding (IRS Pub 15-T, percentage method for automated systems, 2020+
 * W-4), Social Security, Medicare and Additional Medicare, FUTA, and California's income tax withholding (EDD Method B),
 * SDI, UI and ETT (PRL-12..14; ADR-0034 §7). Pure functions over yearly tables, so they're tested against the agencies'
 * worked examples without a database. Amounts are bigint cents; rates are parts per million.
 */
import { divRound } from './rounding.js';
import type { PayFrequency } from './payroll.js';
import {
  PAYROLL_TAX_TABLES,
  type CaPeriodTables,
  type PayrollTaxYear,
  type TaxBracket,
} from './payroll-tax-tables.js';

export * from './payroll-tax-tables.js';

const PPM = 1_000_000n;

/** `amount` × `ppm` / 1,000,000, to the cent, half up. */
export const applyRate = (amount: bigint, ppm: bigint): bigint => divRound(amount * ppm, PPM);

const max0 = (n: bigint): bigint => (n > 0n ? n : 0n);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The tax on `taxable` from a bracket table: the bracket's base plus its rate on the excess over its floor. */
export function bracketTax(brackets: readonly TaxBracket[], taxable: bigint): bigint {
  if (taxable <= 0n) return 0n;
  let row = brackets[0]!;
  for (const b of brackets) if (taxable > b.over) row = b;
  return row.base + applyRate(taxable - row.over, row.rate);
}

/** The tables for a tax year, or null when Montra doesn't have them (the run then says so, and taxes are entered). */
export const payrollTaxYear = (year: number): PayrollTaxYear | null => PAYROLL_TAX_TABLES[year] ?? null;

// ----- Federal income tax (Pub 15-T Worksheet 1A) -----------------------------------------------------------------

export type W4FilingStatus = 'single' | 'married_jointly' | 'head_of_household';

export interface W4Figures {
  filingStatus: W4FilingStatus;
  /** Step 2(c): the higher-rate schedules. */
  multipleJobs: boolean;
  /** Step 3, a yearly amount. */
  dependents: bigint;
  /** Step 4(a), (b): yearly. Step 4(c): per pay period. */
  otherIncome: bigint;
  deductions: bigint;
  extraWithholding: bigint;
  exempt: boolean;
}

export interface FitWorksheet {
  /** 1c: the period's taxable wages, annualized. */
  annualWages: bigint;
  /** 1i: after Step 4(a), Step 4(b) and the line 1g allowance. */
  adjustedAnnualWages: bigint;
  /** 2h: the tentative withholding for the period. */
  tentative: bigint;
  /** 3b: the Step 3 credit for the period. */
  credit: bigint;
  /** 4b: what to withhold. */
  withholding: bigint;
}

/**
 * Worksheet 1A, line by line. `wages` are this period's wages subject to income tax (after 401(k) and cafeteria-plan
 * deductions). Each division is rounded to the cent, half up.
 */
export function federalWithholding(
  t: PayrollTaxYear,
  wages: bigint,
  periodsPerYear: number,
  w4: W4Figures | null,
): FitWorksheet {
  // No W-4: single, standard schedule, no adjustments (Pub 15-T, "Employees who don't give you a W-4").
  const f: W4Figures = w4 ?? {
    filingStatus: 'single',
    multipleJobs: false,
    dependents: 0n,
    otherIncome: 0n,
    deductions: 0n,
    extraWithholding: 0n,
    exempt: false,
  };
  const periods = BigInt(periodsPerYear);
  const annualWages = max0(wages) * periods;
  if (f.exempt) return { annualWages, adjustedAnnualWages: 0n, tentative: 0n, credit: 0n, withholding: 0n };
  const line1g = f.multipleJobs
    ? 0n
    : f.filingStatus === 'married_jointly'
      ? t.federal.line1gMarried
      : t.federal.line1gOther;
  const adjustedAnnualWages = max0(annualWages + f.otherIncome - f.deductions - line1g);
  const schedule = (f.multipleJobs ? t.federal.step2 : t.federal.standard)[f.filingStatus];
  const tentative = divRound(bracketTax(schedule, adjustedAnnualWages), periods);
  const credit = divRound(f.dependents, periods);
  const withholding = max0(tentative - credit) + f.extraWithholding;
  return { annualWages, adjustedAnnualWages, tentative, credit, withholding };
}

// ----- Social Security, Medicare, FUTA ----------------------------------------------------------------------------

export interface FicaResult {
  ssWages: bigint;
  ss: bigint;
  medicareWages: bigint;
  medicare: bigint;
  addlMedicareWages: bigint;
  addlMedicare: bigint;
  /** The employer's matching shares (no Additional Medicare). */
  ssEmployer: bigint;
  medicareEmployer: bigint;
}

/** `wages` and `ytdWages` are wages subject to FICA (after cafeteria-plan deductions, before 401(k)). */
export function fica(t: PayrollTaxYear, wages: bigint, ytdWages: bigint): FicaResult {
  const w = max0(wages);
  const ssWages = min(w, max0(t.fica.ssWageBase - ytdWages));
  const addlMedicareWages =
    max0(ytdWages + w - t.fica.addlMedicareThreshold) - max0(ytdWages - t.fica.addlMedicareThreshold);
  return {
    ssWages,
    ss: applyRate(ssWages, t.fica.ssRate),
    medicareWages: w,
    medicare: applyRate(w, t.fica.medicareRate),
    addlMedicareWages,
    addlMedicare: applyRate(addlMedicareWages, t.fica.addlMedicareRate),
    ssEmployer: applyRate(ssWages, t.fica.ssRate),
    medicareEmployer: applyRate(w, t.fica.medicareRate),
  };
}

/** The part of this period's wages under a yearly wage base, given what's been paid before. */
export const underWageBase = (wages: bigint, ytdWages: bigint, base: bigint): bigint =>
  min(max0(wages), max0(base - ytdWages));

/** FUTA at the net rate (6.0% less the 5.4% credit). A state's credit reduction is owed with Form 940, not per check. */
export function futa(t: PayrollTaxYear, wages: bigint, ytdWages: bigint): { wages: bigint; tax: bigint } {
  const taxable = underWageBase(wages, ytdWages, t.futa.wageBase);
  return { wages: taxable, tax: applyRate(taxable, t.futa.netRate) };
}

// ----- California (EDD Method B, SDI, UI, ETT) --------------------------------------------------------------------

export type De4FilingStatus = 'single' | 'married' | 'head_of_household';

export interface De4Figures {
  /** "Single or married (with two or more incomes)", "married (one income)" or "head of household". */
  filingStatus: De4FilingStatus;
  /** DE 4 line 1: regular withholding allowances. */
  allowances: number;
  /** DE 4 line 2: additional allowances for estimated deductions. */
  estimatedDeductionAllowances: number;
  /** DE 4 line 3: an extra amount per pay period. */
  extraWithholding: bigint;
  exempt: boolean;
}

/** No DE 4 on file: withhold as single with no allowances (EDD, DE 4 instructions). */
export const DEFAULT_DE4: De4Figures = {
  filingStatus: 'single',
  allowances: 0,
  estimatedDeductionAllowances: 0,
  extraWithholding: 0n,
  exempt: false,
};

export interface CaPitWorksheet {
  /** Step 1: at or under the low-income exemption, nothing is withheld. */
  lowIncome: boolean;
  /** Step 2: after the estimated-deduction allowance. */
  wagesSubject: bigint;
  /** Step 3: after the standard deduction. */
  taxable: bigint;
  /** Step 4. */
  computedTax: bigint;
  /** Step 5: the exemption allowance credit. */
  credit: bigint;
  withholding: bigint;
}

/** A row from a table that lists 1 to 10 and says to multiply the one-allowance amount beyond that. */
const allowanceAmount = (rows: readonly bigint[], n: number): bigint =>
  n <= 0 ? 0n : n <= rows.length ? rows[n - 1]! : rows[0]! * BigInt(n);

/** Method B, steps 1 to 5, for one payroll period's table. `wages` are wages subject to California income tax. */
export function caWithholdingFor(tables: CaPeriodTables, wages: bigint, de4: De4Figures): CaPitWorksheet {
  const none = {
    lowIncome: false,
    wagesSubject: 0n,
    taxable: 0n,
    computedTax: 0n,
    credit: 0n,
    withholding: 0n,
  };
  if (de4.exempt) return none;
  const totalAllowances = de4.allowances + de4.estimatedDeductionAllowances;
  // The low-income and standard-deduction tables have a column for married with 0 or 1 allowances.
  const column =
    de4.filingStatus === 'single'
      ? 'single'
      : de4.filingStatus === 'head_of_household'
        ? 'headOfHousehold'
        : totalAllowances >= 2
          ? 'married2'
          : 'married01';
  if (wages <= tables.lowIncome[column]) return { ...none, lowIncome: true };
  const wagesSubject = wages - allowanceAmount(tables.estimatedDeduction, de4.estimatedDeductionAllowances);
  const taxable = max0(wagesSubject - tables.standardDeduction[column]);
  const computedTax = bracketTax(tables.rates[de4.filingStatus], taxable);
  // The credit counts regular allowances only.
  const credit = allowanceAmount(tables.exemptionAllowance, de4.allowances);
  const withholding = max0(computedTax - credit) + de4.extraWithholding;
  return { lowIncome: false, wagesSubject, taxable, computedTax, credit, withholding };
}

/** California withholding for a pay frequency, from that period's tables. */
export function caWithholding(
  t: PayrollTaxYear,
  frequency: PayFrequency,
  wages: bigint,
  de4: De4Figures | null,
): CaPitWorksheet {
  return caWithholdingFor(t.california.periods[frequency], max0(wages), de4 ?? DEFAULT_DE4);
}

/** SDI on all wages (no wage limit since 2024, when it's null). */
export function caSdi(t: PayrollTaxYear, wages: bigint, ytdWages: bigint): { wages: bigint; tax: bigint } {
  const limit = t.california.sdiWageLimit;
  const taxable = limit === null ? max0(wages) : underWageBase(wages, ytdWages, limit);
  return { wages: taxable, tax: applyRate(taxable, t.california.sdiRate) };
}

/** UI at the business's own rate and ETT, both on the first $7,000 a year. */
export function caUiEtt(
  t: PayrollTaxYear,
  wages: bigint,
  ytdWages: bigint,
  uiRate: bigint,
  ettRate: bigint,
): { wages: bigint; ui: bigint; ett: bigint } {
  const taxable = underWageBase(wages, ytdWages, t.california.uiWageBase);
  return { wages: taxable, ui: applyRate(taxable, uiRate), ett: applyRate(taxable, ettRate) };
}

// ----- What each tax is levied on --------------------------------------------------------------------------------

/** Before-tax deductions Montra knows how to treat. */
export type PreTaxCode = 'retirement' | 'section125';
export const PRE_TAX_CODES: readonly PreTaxCode[] = ['retirement', 'section125'];

export interface WageParts {
  gross: bigint;
  /** 401(k), 403(b) and similar: out of income tax only. */
  retirement: bigint;
  /** Cafeteria plan (health, dental, FSA, HSA through the plan): out of every tax here. */
  section125: bigint;
}

/** Income-tax wages (federal and California): gross less both kinds of before-tax deduction. */
export const incomeTaxWages = (w: WageParts): bigint => max0(w.gross - w.retirement - w.section125);
/** FICA, FUTA, SDI and UI wages: gross less cafeteria-plan deductions; 401(k) deferrals stay in. */
export const employmentTaxWages = (w: WageParts): bigint => max0(w.gross - w.section125);
