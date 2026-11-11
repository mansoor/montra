/**
 * The payroll tax engine port (PRL-21; ADR-0034 §7). A pay run asks the engine for each paycheck's taxes and stores only
 * the lines it returns, so the built-in engine (stage 3) or a payroll provider's can replace this one without changing
 * stored pay runs or the ledger.
 */
import type { CalendarDate } from '@montra/domain';

export const PAYROLL_TAX_ENGINE = Symbol('PAYROLL_TAX_ENGINE');

/** The codes a tax line can have. Employee taxes reduce net pay; employer taxes are owed on top of it. */
export const EMPLOYEE_TAX_CODES = ['fit', 'ss', 'medicare', 'addl_medicare', 'ca_pit', 'ca_sdi'] as const;
export const EMPLOYER_TAX_CODES = ['ss_er', 'medicare_er', 'futa', 'ca_ui', 'ca_ett'] as const;
export type EmployeeTaxCode = (typeof EMPLOYEE_TAX_CODES)[number];
export type EmployerTaxCode = (typeof EMPLOYER_TAX_CODES)[number];

export interface TaxInput {
  entityId: string;
  payDate: CalendarDate;
  periodsPerYear: number;
  /** Wages this paycheck, before and after pre-tax deductions. */
  gross: bigint;
  preTax: bigint;
  /** The same, so far this calendar year before this paycheck (approved runs only). */
  ytdGross: bigint;
  ytdPreTax: bigint;
  workState: string | null;
  /** The W-4 in force on the pay date, if any. */
  w4: {
    filingStatus: 'single' | 'married_jointly' | 'head_of_household';
    multipleJobs: boolean;
    dependents: bigint;
    otherIncome: bigint;
    deductions: bigint;
    extraWithholding: bigint;
    exempt: boolean;
  } | null;
}

export interface TaxLine {
  kind: 'employee_tax' | 'employer_tax';
  code: EmployeeTaxCode | EmployerTaxCode;
  label: string;
  amount: bigint;
  /** The wages it was worked out on. */
  taxable: bigint;
}

export interface PayrollTaxEngine {
  /** Stored on each pay run, so a run says how its taxes were found. */
  readonly name: string;
  compute(input: TaxInput): Promise<TaxLine[]>;
}

/** Until stage 3: no taxes are worked out, and the owner enters each paycheck's taxes on the draft. */
export class ManualTaxEngine implements PayrollTaxEngine {
  readonly name = 'manual';
  async compute(): Promise<TaxLine[]> {
    return [];
  }
}

export const TAX_LABELS: Record<EmployeeTaxCode | EmployerTaxCode, string> = {
  fit: 'Federal income tax',
  ss: 'Social Security',
  medicare: 'Medicare',
  addl_medicare: 'Additional Medicare',
  ca_pit: 'California income tax',
  ca_sdi: 'California SDI',
  ss_er: 'Social Security (employer)',
  medicare_er: 'Medicare (employer)',
  futa: 'Federal unemployment (FUTA)',
  ca_ui: 'California UI',
  ca_ett: 'California ETT',
};
