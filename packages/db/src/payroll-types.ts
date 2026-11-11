/**
 * Kysely table types for payroll (migration 0031+, ADR-0034). Kept apart from `types.ts` so payroll's stages don't
 * collide with other work there; `Database` extends `PayrollDatabase`.
 */
import type { ColumnType, Generated, Selectable } from 'kysely';

type CalendarDateCol = ColumnType<string, string, string>;
type Int8 = ColumnType<bigint, bigint | number | string, bigint | number | string>;
type Int8Default = ColumnType<bigint, bigint | number | string | undefined, bigint | number | string>;

export type PayrollPersonKind = 'employee' | 'contractor';
export type TinType = 'ssn' | 'itin' | 'ein';

export interface PayrollPersonTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  kind: PayrollPersonKind;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  business_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: Generated<string>;
  tin_type: TinType | null;
  tin_enc: Buffer | null;
  tin_last4: string | null;
  birth_date_enc: Buffer | null;
  hire_date: CalendarDateCol | null;
  end_date: CalendarDateCol | null;
  pay_type: 'hourly' | 'salary' | null;
  rate_minor: Int8 | null;
  work_state: string | null;
  bank_routing_enc: Buffer | null;
  bank_account_enc: Buffer | null;
  bank_account_type: 'checking' | 'savings' | null;
  bank_last4: string | null;
  vendor_party_id: string | null;
  notes: string | null;
  /** Stage 2 (migration 0032). */
  pay_schedule_id: string | null;
  default_hours_milli: Int8 | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type W4FilingStatus = 'single' | 'married_jointly' | 'head_of_household';

export interface PayrollW4Table {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  person_id: string;
  effective_date: CalendarDateCol;
  legal_name: string;
  address: string | null;
  tin_enc: Buffer | null;
  tin_last4: string | null;
  filing_status: W4FilingStatus;
  multiple_jobs: Generated<boolean>;
  dependents_minor: Int8Default;
  other_income_minor: Int8Default;
  deductions_minor: Int8Default;
  extra_withholding_minor: Int8Default;
  exempt: Generated<boolean>;
  signed_name: string;
  signed_on: CalendarDateCol;
  created_by: string | null;
  created_at: Generated<Date>;
}

export type W9TaxClassification =
  | 'individual'
  | 'c_corporation'
  | 's_corporation'
  | 'partnership'
  | 'trust_estate'
  | 'llc_c'
  | 'llc_s'
  | 'llc_p'
  | 'other';

export interface PayrollW9Table {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  person_id: string;
  legal_name: string;
  business_name: string | null;
  tax_classification: W9TaxClassification;
  other_classification: string | null;
  foreign_partners: Generated<boolean>;
  exempt_payee_code: string | null;
  fatca_code: string | null;
  address: string;
  account_numbers: string | null;
  tin_type: TinType;
  tin_enc: Buffer;
  tin_last4: string;
  backup_withholding: Generated<boolean>;
  signed_name: string;
  signed_on: CalendarDateCol;
  created_by: string | null;
  created_at: Generated<Date>;
}

export type I9Citizenship = 'citizen' | 'noncitizen_national' | 'permanent_resident' | 'authorized_alien';

export interface PayrollI9Table {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  person_id: string;
  last_name: string;
  first_name: string;
  middle_initial: string | null;
  other_last_names: string | null;
  address: string | null;
  apartment: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  birth_date_enc: Buffer | null;
  ssn_enc: Buffer | null;
  ssn_last4: string | null;
  email: string | null;
  phone: string | null;
  citizenship: I9Citizenship | null;
  a_number_enc: Buffer | null;
  work_until: CalendarDateCol | null;
  i94_number_enc: Buffer | null;
  passport_number_enc: Buffer | null;
  passport_country: string | null;
  employee_signed_name: string | null;
  employee_signed_on: CalendarDateCol | null;
  preparer_name: string | null;
  preparer_address: string | null;
  preparer_signed_on: CalendarDateCol | null;
  first_day: CalendarDateCol | null;
  additional_info: string | null;
  employer_signed_name: string | null;
  employer_title: string | null;
  employer_signed_on: CalendarDateCol | null;
  employer_business_name: string | null;
  employer_business_address: string | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PayrollI9DocumentTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  i9_id: string;
  list: 'A' | 'B' | 'C';
  title: string;
  issuing_authority: string | null;
  number_enc: Buffer | null;
  number_last4: string | null;
  expires_on: CalendarDateCol | null;
  file_ids: ColumnType<string[], string[] | undefined, string[]>;
  created_by: string | null;
  created_at: Generated<Date>;
}

// ----- Stage 2: pay runs (migration 0032) --------------------------------------------------------------------------

export type PayScheduleFrequency = 'biweekly' | 'semimonthly' | 'monthly';

export interface PayScheduleTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  name: string;
  frequency: PayScheduleFrequency;
  anchor_date: CalendarDateCol;
  pay_lag_days: Generated<number>;
  pay_from_account_id: string | null;
  archived_at: Date | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PayRunTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  schedule_id: string | null;
  period_start: CalendarDateCol;
  period_end: CalendarDateCol;
  pay_date: CalendarDateCol;
  status: Generated<'draft' | 'approved'>;
  pay_from_account_id: string | null;
  engine: Generated<string>;
  notes: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PaycheckTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  pay_run_id: string;
  person_id: string;
  person_name: string;
  w4_id: string | null;
  gross_minor: Int8Default;
  pre_tax_minor: Int8Default;
  employee_taxes_minor: Int8Default;
  post_tax_minor: Int8Default;
  reimbursements_minor: Int8Default;
  net_minor: Int8Default;
  employer_taxes_minor: Int8Default;
  transaction_id: string | null;
  version: Int8Default;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PaycheckLineKind =
  'earning' | 'pre_tax_deduction' | 'employee_tax' | 'post_tax_deduction' | 'reimbursement' | 'employer_tax';

export interface PaycheckLineTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  paycheck_id: string;
  kind: PaycheckLineKind;
  code: string;
  label: string;
  hours_milli: Int8 | null;
  rate_minor: Int8 | null;
  amount_minor: Int8;
  taxable_minor: Int8 | null;
  source: Generated<'computed' | 'manual'>;
  reimbursement_id: string | null;
  sort_order: Generated<number>;
}

export interface ReimbursementTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  person_id: string;
  person_name: string;
  spent_on: CalendarDateCol;
  description: string;
  amount_minor: Int8;
  currency: string;
  expense_account_id: string;
  file_ids: ColumnType<string[], string[] | undefined, string[]>;
  status: Generated<'submitted' | 'approved' | 'declined'>;
  pay_via: 'pay_run' | 'bill' | null;
  decided_by: string | null;
  decided_at: Date | null;
  decline_reason: string | null;
  paycheck_id: string | null;
  bill_id: string | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PayrollDatabase {
  'app.payroll_person': PayrollPersonTable;
  'app.payroll_w4': PayrollW4Table;
  'app.payroll_w9': PayrollW9Table;
  'app.payroll_i9': PayrollI9Table;
  'app.payroll_i9_document': PayrollI9DocumentTable;
  'app.pay_schedule': PayScheduleTable;
  'app.pay_run': PayRunTable;
  'app.paycheck': PaycheckTable;
  'app.paycheck_line': PaycheckLineTable;
  'app.reimbursement': ReimbursementTable;
}

export type PayrollPersonRow = Selectable<PayrollPersonTable>;
export type PayrollW4Row = Selectable<PayrollW4Table>;
export type PayrollW9Row = Selectable<PayrollW9Table>;
export type PayrollI9Row = Selectable<PayrollI9Table>;
export type PayrollI9DocumentRow = Selectable<PayrollI9DocumentTable>;
export type PayScheduleRow = Selectable<PayScheduleTable>;
export type PayRunRow = Selectable<PayRunTable>;
export type PaycheckRow = Selectable<PaycheckTable>;
export type PaycheckLineRow = Selectable<PaycheckLineTable>;
export type ReimbursementRow = Selectable<ReimbursementTable>;
