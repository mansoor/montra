/**
 * Tax reference data (OPS-05), keyed by country so other markets are a data change (design 10, assumption 1). Codes are
 * what `ledger_account.tax_line_code` holds; see `chart-templates.ts`. Line labels follow IRS Schedule C and E.
 */
export interface TaxLine {
  code: string;
  form: 'schedule_c' | 'schedule_e';
  line: string;
  label: string;
  /** The share usually deductible. Meals are generally 50%. */
  deductibleBps?: number;
}

export const US_TAX_LINES: TaxLine[] = [
  { code: 'US_SCH_C_L1', form: 'schedule_c', line: '1', label: 'Gross receipts or sales' },
  { code: 'US_SCH_C_L6', form: 'schedule_c', line: '6', label: 'Other income' },
  { code: 'US_SCH_C_L8', form: 'schedule_c', line: '8', label: 'Advertising' },
  { code: 'US_SCH_C_L9', form: 'schedule_c', line: '9', label: 'Car and truck expenses' },
  { code: 'US_SCH_C_L10', form: 'schedule_c', line: '10', label: 'Commissions and fees' },
  { code: 'US_SCH_C_L11', form: 'schedule_c', line: '11', label: 'Contract labor' },
  { code: 'US_SCH_C_L15', form: 'schedule_c', line: '15', label: 'Insurance (other than health)' },
  { code: 'US_SCH_C_L16B', form: 'schedule_c', line: '16b', label: 'Interest (other)' },
  { code: 'US_SCH_C_L17', form: 'schedule_c', line: '17', label: 'Legal and professional services' },
  { code: 'US_SCH_C_L18', form: 'schedule_c', line: '18', label: 'Office expense' },
  {
    code: 'US_SCH_C_L20B',
    form: 'schedule_c',
    line: '20b',
    label: 'Rent or lease (other business property)',
  },
  { code: 'US_SCH_C_L21', form: 'schedule_c', line: '21', label: 'Repairs and maintenance' },
  { code: 'US_SCH_C_L22', form: 'schedule_c', line: '22', label: 'Supplies' },
  { code: 'US_SCH_C_L23', form: 'schedule_c', line: '23', label: 'Taxes and licenses' },
  { code: 'US_SCH_C_L24A', form: 'schedule_c', line: '24a', label: 'Travel' },
  {
    code: 'US_SCH_C_L24B',
    form: 'schedule_c',
    line: '24b',
    label: 'Deductible meals',
    deductibleBps: 5000,
  },
  { code: 'US_SCH_C_L25', form: 'schedule_c', line: '25', label: 'Utilities' },
  { code: 'US_SCH_C_L26', form: 'schedule_c', line: '26', label: 'Wages (less employment credits)' },
  { code: 'US_SCH_C_L27A', form: 'schedule_c', line: '27a', label: 'Other expenses' },
  { code: 'US_SCH_E_L3', form: 'schedule_e', line: '3', label: 'Rents received' },
  { code: 'US_SCH_E_L5', form: 'schedule_e', line: '5', label: 'Advertising' },
  { code: 'US_SCH_E_L6', form: 'schedule_e', line: '6', label: 'Auto and travel' },
  { code: 'US_SCH_E_L7', form: 'schedule_e', line: '7', label: 'Cleaning and maintenance' },
  { code: 'US_SCH_E_L8', form: 'schedule_e', line: '8', label: 'Commissions' },
  { code: 'US_SCH_E_L9', form: 'schedule_e', line: '9', label: 'Insurance' },
  { code: 'US_SCH_E_L10', form: 'schedule_e', line: '10', label: 'Legal and other professional fees' },
  { code: 'US_SCH_E_L11', form: 'schedule_e', line: '11', label: 'Management fees' },
  { code: 'US_SCH_E_L12', form: 'schedule_e', line: '12', label: 'Mortgage interest paid to banks' },
  { code: 'US_SCH_E_L13', form: 'schedule_e', line: '13', label: 'Other interest' },
  { code: 'US_SCH_E_L14', form: 'schedule_e', line: '14', label: 'Repairs' },
  { code: 'US_SCH_E_L15', form: 'schedule_e', line: '15', label: 'Supplies' },
  { code: 'US_SCH_E_L16', form: 'schedule_e', line: '16', label: 'Taxes' },
  { code: 'US_SCH_E_L17', form: 'schedule_e', line: '17', label: 'Utilities' },
  { code: 'US_SCH_E_L18', form: 'schedule_e', line: '18', label: 'Depreciation expense or depletion' },
  { code: 'US_SCH_E_L19', form: 'schedule_e', line: '19', label: 'Other' },
];

export interface MileageRate {
  effectiveFrom: string;
  /** 72.5 cents = 725. */
  tenthsOfCent: number;
  source: string;
}

/**
 * IRS business standard mileage rates, from https://www.irs.gov/tax-professionals/standard-mileage-rates (checked
 * 2026-11-03). Rates apply from a date because they can change mid-year: 2022 and 2026 both did, on July 1.
 */
export const US_MILEAGE_RATES: MileageRate[] = [
  { effectiveFrom: '2019-01-01', tenthsOfCent: 580, source: 'IR-2018-251' },
  { effectiveFrom: '2020-01-01', tenthsOfCent: 575, source: 'IR-2019-215' },
  { effectiveFrom: '2021-01-01', tenthsOfCent: 560, source: 'IR-2020-279' },
  { effectiveFrom: '2022-01-01', tenthsOfCent: 585, source: 'IR-2021-251' },
  { effectiveFrom: '2022-07-01', tenthsOfCent: 625, source: 'IR-2022-124' },
  { effectiveFrom: '2023-01-01', tenthsOfCent: 655, source: 'IR-2022-234' },
  { effectiveFrom: '2024-01-01', tenthsOfCent: 670, source: 'IR-2023-239' },
  { effectiveFrom: '2025-01-01', tenthsOfCent: 700, source: 'IR-2024-312' },
  { effectiveFrom: '2026-01-01', tenthsOfCent: 725, source: 'IR-2025-128' },
  { effectiveFrom: '2026-07-01', tenthsOfCent: 760, source: 'IR-2026-29' },
];
