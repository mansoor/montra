-- Business assets, who spent, meal details and mileage by driver (BIZ-16..20; ADR-0035).
-- An asset register in the ledger with yearly depreciation and disposal, assets handed to payroll people, expense
-- details kept beside a transaction (who spent, attendees, business purpose), and a driver on each trip so an employee's
-- trip isn't the owner's mileage deduction.

-- ---------------------------------------------------------------------------------------------
-- BIZ-16: the asset register. Cost and amounts are in the business's currency.
-- ---------------------------------------------------------------------------------------------
create table app.business_asset (
  workspace_id               uuid not null,
  id                         uuid not null default gen_random_uuid(),
  entity_id                  uuid not null,
  name                       text not null check (length(name) between 1 and 200),
  category                   text not null check (category in ('equipment', 'computers', 'furniture', 'vehicle',
                               'software', 'other')),
  serial                     text check (length(serial) <= 100),
  cost_minor                 bigint not null check (cost_minor > 0),
  currency                   text not null,
  in_service_date            date not null,
  method                     text not null check (method in ('expense_now', 'straight_line', 'macrs_half_year')),
  life_years                 integer not null check (life_years in (3, 5, 7, 10)),
  -- What the owner elected to deduct in the first year under Section 179; the rest is depreciated (ADR-0035 §3).
  section_179_minor          bigint not null default 0 check (section_179_minor >= 0),
  -- The purchase it came from. A depreciating asset owns it (`assetId` in its spec) and keeps what it was before.
  transaction_id             uuid,
  previous_spec              jsonb,
  -- Without a purchase: the owner's contribution of it to the business.
  capital_entry_id           uuid,
  disposed_on                date,
  disposal_proceeds_minor    bigint check (disposal_proceeds_minor >= 0),
  disposal_note              text check (length(disposal_note) <= 500),
  disposal_entry_id          uuid,
  disposal_transaction_id    uuid,
  disposal_previous_spec     jsonb,
  notes                      text check (length(notes) <= 2000),
  version                    bigint not null default 1,
  created_by                 uuid references app.app_user (id),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (workspace_id, id),
  check (section_179_minor <= cost_minor),
  check (method <> 'expense_now' or section_179_minor = 0),
  check ((disposed_on is null) = (disposal_proceeds_minor is null)),
  check (disposed_on is null or disposed_on >= in_service_date),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id),
  foreign key (workspace_id, capital_entry_id) references app.journal_entry (workspace_id, id),
  foreign key (workspace_id, disposal_entry_id) references app.journal_entry (workspace_id, id),
  foreign key (workspace_id, disposal_transaction_id) references app.transaction (workspace_id, id)
);
create index business_asset_entity on app.business_asset (workspace_id, entity_id, in_service_date desc);
-- One purchase makes one asset.
create unique index business_asset_transaction on app.business_asset (workspace_id, transaction_id)
  where transaction_id is not null;

-- BIZ-16: which years are posted, and the entry for each. Deleting the entry un-posts the year.
create table app.asset_depreciation (
  workspace_id      uuid not null,
  id                uuid not null default gen_random_uuid(),
  entity_id         uuid not null,
  asset_id          uuid not null,
  year              integer not null check (year between 1990 and 2200),
  amount_minor      bigint not null check (amount_minor > 0),
  journal_entry_id  uuid not null,
  created_by        uuid references app.app_user (id),
  created_at        timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, asset_id, year),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, asset_id) references app.business_asset (workspace_id, id) on delete cascade,
  foreign key (workspace_id, journal_entry_id) references app.journal_entry (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- BIZ-17: who holds an asset. One open assignment per asset; returned ones are its history. The name is copied,
-- because readers of the register can't read payroll records (ADR-0034 §2).
-- ---------------------------------------------------------------------------------------------
create table app.asset_assignment (
  workspace_id   uuid not null,
  id             uuid not null default gen_random_uuid(),
  entity_id      uuid not null,
  asset_id       uuid not null,
  person_id      uuid not null,
  person_name    text not null check (length(person_name) between 1 and 300),
  assigned_on    date not null,
  returned_on    date,
  note           text check (length(note) <= 500),
  version        bigint not null default 1,
  created_by     uuid references app.app_user (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, id),
  check (returned_on is null or returned_on >= assigned_on),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, asset_id) references app.business_asset (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id) on delete cascade
);
create unique index asset_assignment_open on app.asset_assignment (workspace_id, asset_id) where returned_on is null;
create index asset_assignment_person on app.asset_assignment (workspace_id, person_id, assigned_on desc);

-- ---------------------------------------------------------------------------------------------
-- BIZ-18: expense details beside a transaction, outside its stored spec, so the poster never sees them. The key
-- starts with the transaction id, so the change feed's row id does too and phones pull the transaction again.
-- ---------------------------------------------------------------------------------------------
create table app.expense_detail (
  workspace_id        uuid not null,
  transaction_id      uuid not null,
  entity_id           uuid not null,
  spent_by            text check (spent_by in ('owner', 'person')),
  spent_by_person_id  uuid,
  spent_by_name       text check (length(spent_by_name) <= 300),
  attendee_names      text[] not null default '{}' check (cardinality(attendee_names) <= 30),
  attendee_party_ids  uuid[] not null default '{}' check (cardinality(attendee_party_ids) <= 30),
  business_purpose    text check (length(business_purpose) <= 500),
  version             bigint not null default 1,
  updated_by          uuid references app.app_user (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (workspace_id, transaction_id),
  check (spent_by is distinct from 'person' or spent_by_name is not null),
  check (spent_by_person_id is null or spent_by = 'person'),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete cascade,
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, spent_by_person_id) references app.payroll_person (workspace_id, id)
    on delete set null (spent_by_person_id)
);
create index expense_detail_spent_by on app.expense_detail (workspace_id, entity_id, spent_by, spent_by_person_id);

-- ---------------------------------------------------------------------------------------------
-- BIZ-19: a trip's driver. Only the owner's trips are the standard-mileage deduction; a person's can be reimbursed.
-- ---------------------------------------------------------------------------------------------
alter table app.mileage_trip
  add column driver            text not null default 'owner' check (driver in ('owner', 'person')),
  add column driver_person_id  uuid,
  add column driver_name       text check (length(driver_name) <= 300),
  add column reimbursement_id  uuid,
  add constraint mileage_trip_driver_name check (driver = 'owner' or driver_name is not null),
  add constraint mileage_trip_driver_person check (driver_person_id is null or driver = 'person'),
  add constraint mileage_trip_driver_fk foreign key (workspace_id, driver_person_id)
    references app.payroll_person (workspace_id, id) on delete set null (driver_person_id),
  add constraint mileage_trip_reimbursement_fk foreign key (workspace_id, reimbursement_id)
    references app.reimbursement (workspace_id, id) on delete set null (reimbursement_id);
create index mileage_trip_driver on app.mileage_trip (workspace_id, entity_id, driver, trip_date);

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants. Readers of the business see the register and details; writers change them.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['business_asset', 'asset_assignment', 'expense_detail'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
  end loop;
  foreach t in array array['business_asset', 'asset_depreciation', 'asset_assignment', 'expense_detail'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.record_change()', t || '_change', t);
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_write', t);
  end loop;
end $$;

grant select, insert, update, delete on app.business_asset, app.asset_depreciation, app.asset_assignment,
  app.expense_detail to montra_app;
