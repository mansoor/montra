/**
 * Kysely table types for business assets and expense details (migration 0035, ADR-0035). Kept apart from `types.ts`, as
 * payroll's are; `Database` extends `AssetDatabase`.
 */
import type { ColumnType, Generated, Selectable } from 'kysely';

type CalendarDateCol = ColumnType<string, string, string>;
type Int8 = ColumnType<bigint, bigint | number | string, bigint | number | string>;
type Int8Default = ColumnType<bigint, bigint | number | string | undefined, bigint | number | string>;
type Json = ColumnType<unknown, unknown, unknown>;

export type AssetCategory = 'equipment' | 'computers' | 'furniture' | 'vehicle' | 'software' | 'other';
export type AssetMethod = 'expense_now' | 'straight_line' | 'macrs_half_year';

export interface BusinessAssetTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  name: string;
  category: AssetCategory;
  serial: string | null;
  cost_minor: Int8;
  currency: string;
  in_service_date: CalendarDateCol;
  method: AssetMethod;
  life_years: number;
  section_179_minor: Int8Default;
  transaction_id: string | null;
  previous_spec: Json | null;
  capital_entry_id: string | null;
  disposed_on: CalendarDateCol | null;
  disposal_proceeds_minor: Int8 | null;
  disposal_note: string | null;
  disposal_entry_id: string | null;
  disposal_transaction_id: string | null;
  disposal_previous_spec: Json | null;
  notes: string | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AssetDepreciationTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  asset_id: string;
  year: number;
  amount_minor: Int8;
  journal_entry_id: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface AssetAssignmentTable {
  workspace_id: string;
  id: Generated<string>;
  entity_id: string;
  asset_id: string;
  person_id: string;
  person_name: string;
  assigned_on: CalendarDateCol;
  returned_on: CalendarDateCol | null;
  note: string | null;
  version: Int8Default;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExpenseDetailTable {
  workspace_id: string;
  transaction_id: string;
  entity_id: string;
  spent_by: 'owner' | 'person' | null;
  spent_by_person_id: string | null;
  spent_by_name: string | null;
  attendee_names: Generated<string[]>;
  attendee_party_ids: Generated<string[]>;
  business_purpose: string | null;
  version: Int8Default;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AssetDatabase {
  'app.business_asset': BusinessAssetTable;
  'app.asset_depreciation': AssetDepreciationTable;
  'app.asset_assignment': AssetAssignmentTable;
  'app.expense_detail': ExpenseDetailTable;
}

export type BusinessAssetRow = Selectable<BusinessAssetTable>;
export type AssetDepreciationRow = Selectable<AssetDepreciationTable>;
export type AssetAssignmentRow = Selectable<AssetAssignmentTable>;
export type ExpenseDetailRow = Selectable<ExpenseDetailTable>;
