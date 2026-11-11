-- Payroll, stage 3: employer tax (PRL-12..16; ADR-0034 §7). Montra works out federal and California payroll taxes,
-- says what to deposit and when, and fills in the quarterly and yearly worksheets. The owner pays through EFTPS and the
-- EDD and records each deposit here, which posts it: withholding out of its liability, the employer's share as expense.

-- ---------------------------------------------------------------------------------------------
-- The business as an employer. An EIN is on every form it sends, so it isn't sealed.
-- ---------------------------------------------------------------------------------------------
create table app.payroll_settings (
  workspace_id              uuid not null,
  entity_id                 uuid not null,
  ein                       text check (ein ~ '^[0-9]{9}$'),
  -- The EDD employer payroll tax account number, 8 digits.
  ca_employer_account       text check (ca_employer_account ~ '^[0-9]{8}$'),
  -- Rates in parts per million (3.4% = 34000). A null UI rate means the new-employer rate.
  ca_ui_rate_ppm            integer check (ca_ui_rate_ppm between 0 and 200000),
  ca_ett_rate_ppm           integer not null default 1000 check (ca_ett_rate_ppm between 0 and 10000),
  -- The IRS sets the schedule each year from the lookback period; a new employer is monthly.
  federal_deposit_schedule  text not null default 'monthly' check (federal_deposit_schedule in ('monthly', 'semiweekly')),
  -- California PIT and SDI follow from the federal schedule and the amounts withheld (DE 44).
  ca_deposit_schedule       text not null default 'quarterly'
                              check (ca_deposit_schedule in ('quarterly', 'monthly', 'semiweekly')),
  version                   bigint not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (workspace_id, entity_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- PRL-14: California's own withholding certificate. Kept as history, like the W-4.
-- ---------------------------------------------------------------------------------------------
create table app.payroll_de4 (
  workspace_id                    uuid not null,
  id                              uuid not null default gen_random_uuid(),
  entity_id                       uuid not null,
  person_id                       uuid not null,
  effective_date                  date not null,
  legal_name                      text not null check (length(legal_name) between 1 and 300),
  address                         text check (length(address) <= 1000),
  tin_enc                         bytea,
  tin_last4                       text check (tin_last4 ~ '^[0-9]{4}$'),
  filing_status                   text not null check (filing_status in ('single', 'married', 'head_of_household')),
  allowances                      integer not null default 0 check (allowances between 0 and 99),         -- line 1
  estimated_deduction_allowances  integer not null default 0 check (estimated_deduction_allowances between 0 and 99), -- line 2
  extra_withholding_minor         bigint not null default 0 check (extra_withholding_minor >= 0),          -- line 3
  exempt                          boolean not null default false,
  signed_name                     text not null check (length(signed_name) between 1 and 300),
  signed_on                       date not null,
  created_by                      uuid references app.app_user (id),
  created_at                      timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, person_id, effective_date),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id) on delete cascade
);

alter table app.paycheck add column de4_id uuid;
alter table app.paycheck
  add constraint paycheck_de4 foreign key (workspace_id, de4_id) references app.payroll_de4 (workspace_id, id);
-- What the engine wants the owner to know (no W-4 on file, another state's taxes to enter, no tables for the year).
alter table app.paycheck add column tax_notes text[] not null default '{}';

-- ---------------------------------------------------------------------------------------------
-- PRL-15: deposits the owner made. What's owed is worked out from approved paychecks; this is what was paid.
-- ---------------------------------------------------------------------------------------------
create table app.payroll_deposit (
  workspace_id         uuid not null,
  id                   uuid not null default gen_random_uuid(),
  entity_id            uuid not null,
  -- 941 taxes (income tax, Social Security, Medicare), FUTA, California PIT and SDI, California UI and ETT.
  tax                  text not null check (tax in ('federal_941', 'federal_940', 'ca_pit_sdi', 'ca_ui_ett')),
  period_start         date not null,
  period_end           date not null check (period_end >= period_start),
  due_date             date not null,
  paid_on              date not null,
  amount_minor         bigint not null check (amount_minor > 0),
  -- The amount by tax code ({"fit": "12000", "ss": "…"}), so posting and the worksheets know what it paid.
  parts                jsonb not null,
  pay_from_account_id  uuid not null,
  transaction_id       uuid,
  -- An EFTPS or EDD confirmation number.
  confirmation         text check (length(confirmation) <= 100),
  version              bigint not null default 1,
  created_by           uuid references app.app_user (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, entity_id, tax, period_start),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, pay_from_account_id) references app.ledger_account (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);
create index payroll_deposit_entity on app.payroll_deposit (workspace_id, entity_id, period_start);

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants. Settings and deposits are read with read access; a DE 4, like a W-4, needs write access.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['payroll_settings', 'payroll_deposit'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()', t || '_audit', t);
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_write', t);
  end loop;
end $$;
create trigger payroll_deposit_change after insert or update or delete on app.payroll_deposit
  for each row execute function app.record_change();

create trigger payroll_de4_audit after insert or update or delete on app.payroll_de4
  for each row execute function app.audit_row();
alter table app.payroll_de4 enable row level security;
alter table app.payroll_de4 force row level security;
create policy payroll_de4_all on app.payroll_de4 for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

grant select, insert, update, delete on app.payroll_settings, app.payroll_de4, app.payroll_deposit to montra_app;
