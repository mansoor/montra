# 03 — Data Model

PostgreSQL 16. All application tables live in schema `app`. Reference data lives in
`ref`. Conventions:

- Primary keys are `uuid` (v7, time-ordered, generated in the app) so mobile can create
  ids offline.
- Every tenant table has `workspace_id uuid not null`, an RLS policy and
  `created_at/updated_at timestamptz`. Mutable aggregates carry `version bigint` for
  optimistic concurrency and `deleted_at` for the 30-day trash (BAK-06).
- Money columns are `bigint` minor units with an adjacent `char(3)` currency. The column
  suffix is `_minor`.
- Business dates are `date`. System timestamps are `timestamptz`.
- Enumerations are `text` columns with `CHECK` constraints, not PG enums, which keeps
  expand/contract migrations simple.

## 1. Entity-relationship overview

```
workspace ─┬─< workspace_member >── user
           ├─< entity ─┬─< ledger_account ──1:1── bank_account (detail for asset/liability accounts)
           │           │        ▲  (categories are income/expense ledger accounts)
           │           ├─< budget ─< budget_line
           │           └─< journal_entry ─< posting >── ledger_account
           ├─< family_member                         └──> family_member, property, unit (tags)
           ├─< transaction ─< journal_entry (1 per entity touched)
           │        ├─< attachment          ├─< transaction_tag >── tag
           │        └── receipt ─< receipt_line
           ├─< import_profile, import_batch ─< import_row
           ├─< rule, payee, recurring_item, expected_item (rent/invoice/bill/payslip/scheduled)
           ├─< property ─< unit ─< lease >── tenant ;  lease ─< rent_charge (expected)
           ├─< customer/vendor (payee.kind) ─< invoice ─< invoice_line ; bill
           ├─< employer ─< payslip ─< payslip_line
           └─< ai_event, audit_log, change_log, job, notification
```

## 2. Identity and tenancy

| Table | Key columns | Notes |
| --- | --- | --- |
| `user` | `id`, `identity_id` (Kratos), `email citext unique`, `display_name`, `locale`, `time_zone`, `date_format`, `week_start`, `email_verified_at`, `deleted_at` | App profile. Credentials live only in Kratos. |
| `workspace` | `id`, `name`, `base_currency`, `time_zone`, `ai_mode` (`builtin`/`byok`/`local`/`off`), `ai_settings jsonb` (provider, endpoint, encrypted key ref, confidence threshold default 0.80, monthly AI budget), `priorities jsonb` (REC rules), `plan` | Owner-level settings. |
| `workspace_member` | `workspace_id`, `user_id`, `role` (`owner`/`partner`/`viewer`/`accountant`), `status` (`invited`/`active`/`revoked`), `invited_email`, `invite_token_hash`, `invite_expires_at` (7 days, AUTH-10) | PK `(workspace_id, user_id)`. |
| `entity_grant` | `workspace_id`, `user_id`, `entity_id`, `access` (`none`/`read`/`write`) | Overrides the role default per entity (BIZ-13, open question on partner visibility). |
| `account_visibility` | `workspace_id`, `user_id`, `ledger_account_id`, `hidden bool` | Per-account visibility (UP-04). |
| `session_device` | `id`, `user_id`, `kratos_session_id`, `device_name`, `platform`, `last_seen_at`, `push_token` | Device list and remote sign-out (AUTH-07). |

## 3. Entities and chart of accounts

| Table | Key columns | Notes |
| --- | --- | --- |
| `entity` | `id`, `workspace_id`, `type` (`personal`/`business`/`rental`), `name`, `functional_currency` (defaults to workspace base, CUR-01), `fiscal_year_start_month`, `business_type` (`sole_prop`/`llc`/`s_corp`/…), `tax_profile jsonb` (country, schedule `C`/`E`, set-aside %), `budget_method`, `archived_at` | Exactly one `personal` entity per workspace (partial unique index). |
| `ledger_account` | `id`, `workspace_id`, `entity_id`, `type` (`asset`/`liability`/`equity`/`income`/`expense`), `subtype`, `name`, `parent_id`, `currency`, `is_category bool`, `category_group_id`, `tax_line_code` (e.g. `SCH_C_L18`, `SCH_E_L9`), `system_role` (nullable, unique per entity: `opening_balance_equity`, `uncategorized_income`, `uncategorized_expense`, `owner_contribution`, `owner_draw`, `inter_entity_clearing`, `due_to_entity`, `due_from_entity`, `fx_gain_loss`, `fx_rounding`, `security_deposits_held`, `bank_fees`), `sort_order`, `archived_at` | DE-02. Bank and card accounts and categories are both rows here. |
| `bank_account` | `ledger_account_id` (PK/FK), `workspace_id`, `kind` (`checking`/`savings`/`credit_card`/`cash`/`loan`/`mortgage`/`line_of_credit`/`investment`/`asset`/`liability`), `institution`, `last4`, `account_number_enc bytea`, `opening_balance_minor`, `opening_date`, `default_member_id`, `credit_limit_minor`, `interest_rate_bps`, `statement_day`, `import_profile_id` | ACC-02/05, FAM-04. `investment` is balance-only. |
| `category_group` | `id`, `workspace_id`, `entity_id`, `name`, `kind` (`fixed`/`daily`/`fun`/`savings`/`debt`/`business`/`rental`/`income`), `sort_order` | BUD-04. |

`ledger_account.type` decides the normal balance: assets and expenses are debit-normal;
liabilities, equity and income are credit-normal. `subtype` refines the UI (for example
`bank`, `card`, `loan_principal`, `escrow`, `category`, `transfer`, `fixed_asset`,
`accumulated_depreciation`).

## 4. Transactions and the ledger

### 4.1 Tables

| Table | Key columns | Notes |
| --- | --- | --- |
| `transaction` | `id`, `workspace_id`, `txn_date date`, `payee_raw`, `payee_id`, `description`, `memo_enc`, `status` (`scheduled`/`pending`/`posted`/`void`), `review_state` (`auto_applied`/`needs_review`/`reviewed`), `source` (`manual`/`camera`/`import`/`receipt`/`payslip`/`recurring`/`system`/`feed`), `import_batch_id`, `import_row_id`, `dedupe_key`, `original_amount_minor`, `original_currency`, `fx_rate`, `trip_id`, `local_time` (receipt time, TZ-03), `recurring_item_id`, `version`, `created_by`, `deleted_at` | The user-facing record. Owns 1..n journal entries. |
| `journal_entry` | `id`, `workspace_id`, `entity_id`, `transaction_id` (nullable for manual journals), `entry_date`, `description`, `kind` (`standard`/`transfer`/`opening_balance`/`adjustment`/`reversal`/`depreciation`/`fx_revaluation`/`closing`/`manual`), `reverses_entry_id`, `locked bool`, `posted_by`, `posted_at` | DE-01, DE-07. |
| `posting` | `id`, `workspace_id`, `journal_entry_id`, `line_no`, `ledger_account_id`, `amount_minor` (signed: **+ debit / − credit**, in the account's currency), `currency`, `functional_amount_minor` (signed, in the entity's functional currency), `fx_rate numeric(20,10)`, `member_id` (null = Household), `property_id`, `unit_id`, `memo`, `cleared` (`uncleared`/`cleared`/`reconciled`), `reconciliation_id`, `receipt_line_id`, `tax_line_code` (override) | DE-01, CUR-07, FAM-03. |
| `tag` / `transaction_tag` | `tag(id, workspace_id, name)`; `(transaction_id, tag_id)` | TXN-02. |
| `reconciliation` | `id`, `workspace_id`, `ledger_account_id`, `statement_date`, `statement_balance_minor`, `status` (`in_progress`/`completed`), `completed_at` | DE-08. |
| `period_lock` | `workspace_id`, `entity_id`, `locked_through date`, `locked_by`, `note` | DE-09. |
| `attachment` | `id`, `workspace_id`, `owner_type`, `owner_id`, `kind` (`receipt`/`statement`/`payslip`/`lease`/`invoice`/`photo`/`other`), `storage_key`, `mime`, `bytes`, `sha256`, `original_storage_key`, `ocr_text`, `retain_until`, `deleted_at` | RCP-10, BIZ-12. OCR text is indexed for search. |

### 4.2 Invariants enforced in the database

| Invariant | Mechanism |
| --- | --- |
| At least 2 postings per entry, and Σ `functional_amount_minor` = 0 (DE-01, CUR-07) | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `posting` (insert/update/delete) and `journal_entry` calls `app.assert_entry_balanced(entry_id)` at commit. |
| Posting's `currency` = account's `currency`; single-currency postings have `amount_minor = functional_amount_minor` | Trigger check plus a CHECK on the rate-1 case. |
| Posting account belongs to the same entity as the entry | Trigger, or a composite FK on `(entity_id, ledger_account_id)` through a `ledger_account (entity_id, id)` unique key. |
| Locked entries and entries on or before `period_lock.locked_through` are immutable (DE-08/09/10) | `BEFORE UPDATE/DELETE` trigger raises unless `app.allow_locked_edit` is set by the audited unlock path. |
| Tenant isolation | RLS: `USING (workspace_id = app.current_workspace_id())` and the same `WITH CHECK`, on every table. |

Application code checks the same rules first (via `packages/domain`) so users get good
error messages. The database is the backstop.

### 4.3 Transaction ↔ journal mapping

- A simple transaction (one entity) has **one** journal entry. This covers expenses,
  income, splits across categories, transfers between accounts of one entity, card
  payments and mortgage payments.
- A transaction that touches **several entities** (DE-05, ACC-03 split across entities)
  produces **one journal entry per entity**, each balanced on its own, linked by
  `transaction_id`. Each entity's books stay self-balancing (needed for P&L and Schedule
  C/E), and the consolidated view eliminates the inter-entity clearing accounts. This
  refines the "owns one journal entry" wording in requirements §11. See
  [ADR-0005](adr/0005-journal-entry-per-entity.md).
- Editing a transaction replaces its postings inside one database transaction (the audit
  log records before/after). If any of its entries is reconciled, locked or in a closed
  period, the edit instead posts a reversal plus a new entry (DE-10).

### 4.4 Read models

| Table | Maintained by | Used for |
| --- | --- | --- |
| `account_balance_daily (workspace_id, ledger_account_id, date, delta_minor, balance_minor)` | worker from the change feed | registers, net worth trend, forecast start balances |
| `category_activity_monthly (workspace_id, entity_id, ledger_account_id, member_id, month, activity_minor)` | worker | budget available, spending pace, dashboard, reports |

Both can be rebuilt from postings at any time (`montra-cli rebuild-read-models`), which
keeps every number reconcilable to transactions (NFR-09, UP-05).

## 5. Import, payees, rules, AI

| Table | Key columns | Notes |
| --- | --- | --- |
| `import_profile` | `id`, `workspace_id`, `name`, `institution`, `fingerprint` (hash of normalized header + column count + file type), `mapping jsonb` (columns, date format, decimal separator, sign convention, header rows, skip patterns), `ledger_account_id`, `use_count` | IMP-03/04. System-wide profiles live in `ref.import_profile`. |
| `import_batch` | `id`, `workspace_id`, `ledger_account_id`, `attachment_id`, `file_name`, `file_type`, `profile_id`, `status` (`uploaded`/`parsing`/`needs_mapping`/`preview`/`committing`/`committed`/`failed`/`undone`), `rows_read/added/matched/skipped/failed`, `statement_opening_minor`, `statement_closing_minor`, `balance_check` (`ok`/`mismatch`/`n_a`), `committed_at`, `undo_until` (committed_at + 30d) | IMP-08/09. |
| `import_row` | `id`, `import_batch_id`, `row_no`, `raw jsonb`, `parsed jsonb` (date, amount, description, balance), `status` (`new`/`duplicate`/`match`/`error`/`skipped`), `match_transaction_id`, `error`, `suggestion jsonb` | Staging for the preview (IMP-06). Purged 30 days after commit. |
| `payee` | `id`, `workspace_id`, `display_name`, `normalized_key`, `merchant_ref_id`, `kind` (`merchant`/`customer`/`vendor`/`employer`/`tenant`/`person`), `default_category_id`, `default_entity_id` | IMP-10, BIZ-04. |
| `payee_alias` | `workspace_id`, `pattern`, `payee_id` | Raw text → payee. |
| `rule` | `id`, `workspace_id`, `entity_id`, `name`, `scope` (`transaction`/`receipt_line`), `priority`, `conditions jsonb`, `actions jsonb`, `origin` (`user`/`ai_suggested`/`correction`), `enabled`, `hit_count`, `last_hit_at` | UP-02, AI-05, RCP-06. Condition and action grammar in [04 §6](04-domain-logic.md#6-rules-engine). |
| `payee_history` | `workspace_id`, `payee_id`, `amount_band`, `category_id`, `entity_id`, `member_id`, `count`, `last_used_at` | Pipeline step 4. |
| `ai_cache` | `workspace_id` (nullable for shared), `task`, `key_hash`, `output jsonb`, `model`, `expires_at` | AIA-07. |
| `ai_event` | `id`, `workspace_id`, `task`, `provider`, `model`, `input_hash`, `output jsonb`, `confidence`, `latency_ms`, `tokens_in/out`, `cost_micro_usd`, `user_action` (`accepted`/`edited`/`rejected`/`pending`), `subject_type/id` | AIA-10. Viewable and deletable by the user. |

## 6. Receipts

| Table | Key columns |
| --- | --- |
| `receipt` | `id`, `workspace_id`, `attachment_ids uuid[]`, `merchant`, `receipt_date`, `local_time`, `currency`, `subtotal_minor`, `tax_minor`, `discount_minor`, `fees_minor`, `tip_minor`, `total_minor`, `card_last4`, `validation_gap_minor`, `status` (`processing`/`inbox`/`matched`/`needs_review`/`rejected`), `transaction_id`, `ocr_text` |
| `receipt_line` | `id`, `receipt_id`, `line_no`, `raw_text`, `expanded_name`, `qty numeric`, `unit_price_minor`, `line_total_minor`, `discount_minor`, `taxable bool`, `category_id`, `entity_id`, `member_id`, `confidence`, `is_return bool` |

## 7. Planning

| Table | Key columns | Notes |
| --- | --- | --- |
| `budget` | `id`, `workspace_id`, `entity_id`, `member_id` (null = household), `method` (`zero_based`/`category_limits`/`light_50_30_20`), `period_type` (`monthly`/`weekly`/`biweekly`), `anchor_date` | BUD-01/05, FAM-06. |
| `budget_period` | `id`, `budget_id`, `start_date`, `end_date`, `expected_income_minor`, `status` | One row per month (or pay period). |
| `budget_line` | `budget_period_id`, `category_id`, `assigned_minor`, `rollover_mode` (`carry_surplus`/`carry_both`/`reset`), `carried_in_minor` | BUD-06. |
| `budget_move` | `id`, `budget_period_id`, `from_category_id`, `to_category_id`, `amount_minor`, `by`, `at`, `note` | BUD-10. |
| `goal` | `id`, `workspace_id`, `entity_id`, `member_id`, `type` (`emergency_fund`/`debt_payoff`/`savings`/`sinking_fund`), `target_minor`, `due_date`, `category_id`, `strategy` (`snowball`/`avalanche`), `linked_account_ids` | BUD-07/08, FAM-07. |
| `expected_income` | `id`, `workspace_id`, `entity_id`, `member_id`, `source_type` (`salary`/`business`/`rent`/`other`), `source_id`, `amount_minor`, `cadence`, `next_date` | BUD-03, derived from payslips and rent roll where possible. |
| `recurring_item` | `id`, `workspace_id`, `payee_id`, `template jsonb` (account, splits), `amount_pattern` (`fixed`/`variable` + min/max/avg), `cadence` (`weekly`/`biweekly`/`semimonthly`/`monthly`/`quarterly`/`yearly`/`custom` RRULE), `next_date`, `auto_create` (`scheduled`/`posted`), `status`, `detected bool`, `last_amount_minor` | TXN-05, AI-08, UP-14. |
| `recommendation` | `id`, `workspace_id`, `type` (`REC-01`…), `period`, `payload jsonb` (numbers + reasoning), `status` (`open`/`accepted`/`edited`/`dismissed`), `notified_at` | 4.3 |

## 8. Expected items and matching

One generic table keeps matching uniform (design note §11):

| Table | Key columns |
| --- | --- |
| `expected_item` | `id`, `workspace_id`, `entity_id`, `kind` (`rent_charge`/`invoice`/`bill`/`payslip_net`/`scheduled`/`loan_payment`), `source_id`, `due_date`, `amount_minor`, `currency`, `counterparty_payee_id`, `ledger_account_id` (where cash is expected), `status` (`open`/`partial`/`paid`/`void`), `paid_minor` |
| `match_link` | `expected_item_id`, `transaction_id`, `amount_minor`, `method` (`auto`/`manual`), `score`, `created_at` |

## 9. Business, rental, members, payroll

| Table | Key columns |
| --- | --- |
| `family_member` | `id`, `workspace_id`, `name`, `relationship`, `birth_date`, `color`, `avatar_attachment_id`, `status` (`active`/`inactive`), `linked_user_id`, `is_dependent` |
| `employer` | `id`, `workspace_id`, `member_id`, `name`, `type` (`employer`/`freelance`/`pension`/`benefits`/`other`), `pay_frequency`, `deposit_account_id`, `payee_id` |
| `payslip` | `id`, `workspace_id`, `employer_id`, `member_id`, `pay_date`, `period_start/end`, `gross_minor`, `net_minor`, `ytd jsonb`, `attachment_id`, `transaction_id`, `deposit_match_transaction_id`, `status` |
| `payslip_line` | `payslip_id`, `section` (`earning`/`pre_tax`/`tax`/`post_tax`/`employer`), `code` (`salary`/`overtime`/`bonus`/`401k`/`hsa`/`fed_tax`/`ssn`/`medicare`/…), `label`, `amount_minor`, `ytd_minor`, `ledger_account_id` |
| `business_profile` | 1:1 with `entity` for businesses: `legal_name`, `ein_enc`, `address`, `invoice_prefix`, `default_terms_days`, `quarterly_tax_rate_bps` |
| `invoice` / `invoice_line` | `invoice(id, entity_id, customer_payee_id, number, issue_date, due_date, status, subtotal/tax/total_minor, pdf_attachment_id, sent_at)` / `(invoice_id, description, qty, unit_price_minor, tax_rate_bps, income_account_id)` |
| `bill` | `id`, `entity_id`, `vendor_payee_id`, `bill_date`, `due_date`, `amount_minor`, `expense_account_id`, `status`, `attachment_id` |
| `mileage_trip` | `id`, `entity_id`, `trip_date`, `from`, `to`, `purpose`, `miles numeric(8,1)`, `rate_ref_id`, `deduction_minor`, `vehicle` |
| `property` | `id`, `workspace_id`, `entity_id` (rental portfolio), `name`, `address jsonb`, `type` (`sfh`/`multi_family`/`condo`/`str`), `purchase_date`, `purchase_price_minor`, `land_value_minor`, `ownership_bps`, `current_value_minor`, `sqft` |
| `unit` | `id`, `property_id`, `label`, `beds`, `baths numeric(3,1)`, `sqft`, `market_rent_minor`, `status` (`occupied`/`vacant`/`under_repair`) |
| `tenant` | `id`, `workspace_id`, `name`, `email`, `phone`, `payee_id` |
| `lease` | `id`, `unit_id`, `start_date`, `end_date`, `rent_minor`, `due_day`, `late_fee_rule jsonb` (grace days, flat/percent, cap), `deposit_minor`, `deposit_account_id`, `status`, `attachment_id`; `lease_tenant(lease_id, tenant_id)` |
| `allocation_rule` | `id`, `workspace_id`, `name`, `basis` (`percent`/`units`/`sqft`), `targets jsonb` | RNT-07 |
| `loan_schedule` | `id`, `ledger_account_id`, `principal_minor`, `rate_bps`, `term_months`, `first_payment_date`, `escrow_minor`, `escrow_split jsonb` | RNT-08 / DE-04 |
| `depreciation_schedule` | `id`, `property_id`, `basis_minor`, `in_service_date`, `method` (`SL_27_5`/`SL_39`), `asset_account_id` | RNT-09 |
| `maintenance_log` | `id`, `property_id`, `unit_id`, `issue`, `vendor_payee_id`, `cost_minor`, `status`, `attachment_ids` | RNT-13 |
| `reminder` | `id`, `workspace_id`, `kind`, `subject_type/id`, `due_date`, `lead_days int[]`, `status` | RNT-12, BIZ-09 |

## 10. Platform tables

| Table | Purpose |
| --- | --- |
| `audit_log (id bigserial, workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff jsonb, ip, user_agent, at)` | NFR-03, AUTH-12. Insert-only; `UPDATE`/`DELETE` revoked from the app role. |
| `change_log (workspace_id, seq bigint, table_name, row_id, op, changed_at)` | Sync change feed. `seq` comes from a per-workspace counter (`workspace_seq` row, updated in the writing transaction), so clients pull `?since=seq` without gaps. Written by a generic trigger on synced tables. |
| `job (id, workspace_id, type, status, progress, result jsonb, error, created_at, finished_at)` | Async job tracking. |
| `notification`, `notification_pref`, `push_token` | NOT-01..03 |
| `idempotency_key (workspace_id, key, request_hash, response jsonb, expires_at)` | Safe retries. |
| `support_grant (workspace_id, granted_by, staff_id, scope, expires_at, revoked_at)` | OPS-02 |
| `ref.currency (code, minor_units, symbol)`, `ref.fx_rate (date, base, quote, rate, source)`, `ref.tax_line`, `ref.mileage_rate`, `ref.merchant`, `ref.mcc` | Reference data (OPS-05) |

## 11. Row-level security

```sql
create function app.current_workspace_id() returns uuid
  language sql stable as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

alter table app.posting enable row level security;
alter table app.posting force row level security;
create policy tenant_isolation on app.posting
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
```

- The runtime role `montra_app` has `NOINHERIT NOBYPASSRLS` and only DML grants.
  Migrations run as `montra_owner`.
- Cross-workspace operations (user sign-up, invite acceptance, admin console) use
  narrowly-scoped `SECURITY DEFINER` functions that are audited and reviewed.
- Workers set the same `app.workspace_id` per job.

## 12. Sensitive fields and encryption (NFR-01)

Fields ending `_enc` (account numbers, memos, EIN, tenant contact details, payslip
amounts at rest) are envelope-encrypted in the application with AES-256-GCM using a
per-workspace data key wrapped by KMS. Searchable needs (e.g. last-4) use separate plain
columns or keyed HMAC columns. Memo search uses a tokenized HMAC index instead of plain
full-text.

## 13. Indexing (initial)

- `posting (workspace_id, ledger_account_id, journal_entry_id)` and
  `journal_entry (workspace_id, entity_id, entry_date)`
- `transaction (workspace_id, txn_date desc)`,
  `transaction (workspace_id, dedupe_key)`,
  `transaction (workspace_id, review_state) where review_state = 'needs_review'`
- `payee (workspace_id, normalized_key)` plus a GIN `pg_trgm` index on `display_name`
- Full-text search: a `tsvector` generated column on
  `transaction (payee_raw, description)` and on `attachment (ocr_text)` (RPT-05)
