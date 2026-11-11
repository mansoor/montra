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

export interface PayrollDatabase {
  'app.payroll_person': PayrollPersonTable;
  'app.payroll_w4': PayrollW4Table;
  'app.payroll_w9': PayrollW9Table;
  'app.payroll_i9': PayrollI9Table;
  'app.payroll_i9_document': PayrollI9DocumentTable;
}

export type PayrollPersonRow = Selectable<PayrollPersonTable>;
export type PayrollW4Row = Selectable<PayrollW4Table>;
export type PayrollW9Row = Selectable<PayrollW9Table>;
export type PayrollI9Row = Selectable<PayrollI9Table>;
export type PayrollI9DocumentRow = Selectable<PayrollI9DocumentTable>;
