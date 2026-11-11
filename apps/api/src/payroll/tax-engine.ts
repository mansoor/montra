/**
 * The payroll tax engine port (PRL-21; ADR-0034 §7). A pay run asks the engine for each paycheck's taxes and stores only
 * the lines it returns, so the built-in engine or a payroll provider's can replace it without changing stored pay runs
 * or the ledger.
 */
import {
  caSdi,
  caUiEtt,
  caWithholding,
  employmentTaxWages,
  federalWithholding,
  fica,
  futa,
  incomeTaxWages,
  payrollTaxYear,
  type CalendarDate,
  type De4Figures,
  type PayFrequency,
  type W4Figures,
  type WageParts,
} from '@montra/domain';
import { formatScaled } from '../business/shared.js';

export const PAYROLL_TAX_ENGINE = Symbol('PAYROLL_TAX_ENGINE');

/** The codes a tax line can have. Employee taxes reduce net pay; employer taxes are owed on top of it. */
export const EMPLOYEE_TAX_CODES = ['fit', 'ss', 'medicare', 'addl_medicare', 'ca_pit', 'ca_sdi'] as const;
export const EMPLOYER_TAX_CODES = ['ss_er', 'medicare_er', 'futa', 'ca_ui', 'ca_ett'] as const;
export type EmployeeTaxCode = (typeof EMPLOYEE_TAX_CODES)[number];
export type EmployerTaxCode = (typeof EMPLOYER_TAX_CODES)[number];

export interface TaxInput {
  entityId: string;
  payDate: CalendarDate;
  frequency: PayFrequency;
  periodsPerYear: number;
  /** This paycheck's wages and before-tax deductions by kind. */
  wages: WageParts;
  /** The same, earlier this calendar year (approved runs only). */
  ytd: WageParts;
  workState: string | null;
  /** The W-4 and DE 4 in force on the pay date, if any. */
  w4: W4Figures | null;
  de4: De4Figures | null;
  /** The business's California UI and ETT rates (ppm); null when not entered yet. */
  caUiRate: bigint | null;
  caEttRate: bigint;
}

export interface TaxLine {
  kind: 'employee_tax' | 'employer_tax';
  code: EmployeeTaxCode | EmployerTaxCode;
  label: string;
  amount: bigint;
  /** The wages it was worked out on. */
  taxable: bigint;
}

export interface TaxResult {
  lines: TaxLine[];
  /** What the owner should know about how the taxes were found, shown on the paycheck. */
  notes: string[];
}

export interface PayrollTaxEngine {
  /** Stored on each pay run, so a run says how its taxes were found. */
  readonly name: string;
  compute(input: TaxInput): Promise<TaxResult>;
}

/** No taxes are worked out; the owner enters each paycheck's taxes on the draft. */
export class ManualTaxEngine implements PayrollTaxEngine {
  readonly name = 'manual';
  async compute(): Promise<TaxResult> {
    return { lines: [], notes: [] };
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

/**
 * Montra's own engine: federal (Pub 15-T percentage method, FICA, FUTA) and California (Method B, SDI, UI, ETT) from the
 * yearly tables in `@montra/domain`. Other states aren't built, so their state taxes are left to be entered.
 */
export class BuiltInTaxEngine implements PayrollTaxEngine {
  readonly name = 'montra';

  async compute(input: TaxInput): Promise<TaxResult> {
    const year = Number(input.payDate.slice(0, 4));
    const t = payrollTaxYear(year);
    if (!t)
      return {
        lines: [],
        notes: [`Montra doesn’t have the ${year} tax tables yet. Enter this paycheck’s taxes.`],
      };
    const lines: TaxLine[] = [];
    const notes: string[] = [];
    const line = (kind: TaxLine['kind'], code: TaxLine['code'], amount: bigint, taxable: bigint) =>
      lines.push({ kind, code, label: TAX_LABELS[code], amount, taxable });

    const incomeWages = incomeTaxWages(input.wages);
    const employment = employmentTaxWages(input.wages);
    const ytdEmployment = employmentTaxWages(input.ytd);

    if (!input.w4) notes.push('No W-4 on file: federal tax is withheld as single with no adjustments.');
    if (input.w4?.exempt) notes.push('The W-4 claims exemption: no federal income tax is withheld.');
    line(
      'employee_tax',
      'fit',
      federalWithholding(t, incomeWages, input.periodsPerYear, input.w4).withholding,
      incomeWages,
    );

    const f = fica(t, employment, ytdEmployment);
    line('employee_tax', 'ss', f.ss, f.ssWages);
    line('employee_tax', 'medicare', f.medicare, f.medicareWages);
    line('employee_tax', 'addl_medicare', f.addlMedicare, f.addlMedicareWages);
    line('employer_tax', 'ss_er', f.ssEmployer, f.ssWages);
    line('employer_tax', 'medicare_er', f.medicareEmployer, f.medicareWages);
    const u = futa(t, employment, ytdEmployment);
    line('employer_tax', 'futa', u.tax, u.wages);

    if (input.workState === 'CA') {
      if (!input.de4) notes.push('No DE 4 on file: California tax is withheld as single with no allowances.');
      if (input.de4?.exempt) notes.push('The DE 4 claims exemption: no California income tax is withheld.');
      line(
        'employee_tax',
        'ca_pit',
        caWithholding(t, input.frequency, incomeWages, input.de4).withholding,
        incomeWages,
      );
      const sdi = caSdi(t, employment, ytdEmployment);
      line('employee_tax', 'ca_sdi', sdi.tax, sdi.wages);
      const uiRate = input.caUiRate ?? t.california.newEmployerUiRate;
      if (input.caUiRate === null)
        notes.push(
          `No UI rate entered for the business: the new-employer rate, ${formatScaled(uiRate, 4)}%, is used.`,
        );
      const ui = caUiEtt(t, employment, ytdEmployment, uiRate, input.caEttRate);
      line('employer_tax', 'ca_ui', ui.ui, ui.wages);
      line('employer_tax', 'ca_ett', ui.ett, ui.wages);
    } else if (input.workState) {
      notes.push(`Montra works out California taxes only. Enter ${input.workState} taxes on this paycheck.`);
    } else {
      notes.push('No work state on file: no state taxes were worked out.');
    }
    return { lines, notes };
  }
}
