-- Phase 9: rental properties (RNT-01..14, UP-10; design 03 §8, 04 §9 and §13, ADR-0018).
-- Cash basis, as for a business (ADR-0017): a rent charge posts nothing, and a payment is what becomes income. What a
-- charge has been paid is derived from the lease's payments, oldest charge first, so it can't disagree with them.

-- ---------------------------------------------------------------------------------------------
-- RNT-01, RNT-02: properties and units.
-- ---------------------------------------------------------------------------------------------
create table app.property (
  workspace_id          uuid not null,
  id                    uuid not null default gen_random_uuid(),
  entity_id             uuid not null,
  name                  text not null check (length(name) between 1 and 200),
  address               text check (length(address) <= 1000),
  type                  text not null default 'sfh' check (type in ('sfh', 'multi_family', 'condo', 'str', 'commercial')),
  purchase_date         date,
  purchase_price_minor  bigint check (purchase_price_minor >= 0),
  land_value_minor      bigint check (land_value_minor >= 0),
  -- For cash-on-cash return (RNT-11): down payment, closing costs and so on. Entered, not derived.
  cash_invested_minor   bigint check (cash_invested_minor >= 0),
  ownership_bps         integer not null default 10000 check (ownership_bps between 1 and 10000),
  current_value_minor   bigint check (current_value_minor >= 0),
  sqft                  integer check (sqft > 0),
  -- RNT-09: where capitalized improvements go. Created the first time one is accepted.
  improvements_account_id uuid,
  archived_at           timestamptz,
  version               bigint not null default 1,
  created_by            uuid references app.app_user (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, improvements_account_id) references app.ledger_account (workspace_id, id)
);

create table app.unit (
  workspace_id       uuid not null,
  id                 uuid not null default gen_random_uuid(),
  entity_id          uuid not null,
  property_id        uuid not null,
  label              text not null check (length(label) between 1 and 100),
  beds               integer check (beds >= 0),
  baths_tenths       integer check (baths_tenths >= 0),      -- 1.5 baths = 15
  sqft               integer check (sqft > 0),
  market_rent_minor  bigint check (market_rent_minor >= 0),
  under_repair       boolean not null default false,          -- occupied or vacant follows from the leases
  archived_at        timestamptz,
  version            bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, property_id, label),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id) on delete cascade
);
create index unit_property on app.unit (workspace_id, property_id);

-- Now the tags on postings have something to point at (RNT-06).
alter table app.posting add foreign key (workspace_id, property_id) references app.property (workspace_id, id);
alter table app.posting add foreign key (workspace_id, unit_id) references app.unit (workspace_id, id);
create index posting_property on app.posting (workspace_id, property_id, entry_date) where property_id is not null;

-- ---------------------------------------------------------------------------------------------
-- RNT-03: tenants and leases. Scoped to the portfolio: contact details don't reach anyone without a grant on it.
-- ---------------------------------------------------------------------------------------------
create table app.tenant (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  name          text not null check (length(name) between 1 and 200),
  email         text check (length(email) <= 320),
  phone         text check (length(phone) <= 50),
  -- How this tenant's payments appear on statements, learned when one is linked.
  payee_keys    text[] not null default '{}',
  notes         text check (length(notes) <= 2000),
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);

create table app.lease (
  workspace_id        uuid not null,
  id                  uuid not null default gen_random_uuid(),
  entity_id           uuid not null,
  property_id         uuid not null,
  unit_id             uuid not null,
  start_date          date not null,
  end_date            date,                            -- null = month to month
  ended_on            date,                            -- moved out early or on time
  rent_minor          bigint not null check (rent_minor > 0),
  due_day             integer not null default 1 check (due_day between 1 and 31),
  late_grace_days     integer not null default 5 check (late_grace_days between 0 and 60),
  late_fee_flat_minor bigint not null default 0 check (late_fee_flat_minor >= 0),
  late_fee_bps        integer not null default 0 check (late_fee_bps between 0 and 10000),
  late_fee_cap_minor  bigint check (late_fee_cap_minor >= 0),
  deposit_minor       bigint not null default 0 check (deposit_minor >= 0),
  deposit_account_id  uuid,                            -- where rent and deposits land
  attachment_ids      uuid[] not null default '{}',
  notes               text check (length(notes) <= 2000),
  version             bigint not null default 1,
  created_by          uuid references app.app_user (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (workspace_id, id),
  check (end_date is null or end_date >= start_date),
  check (ended_on is null or ended_on >= start_date),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id),
  foreign key (workspace_id, unit_id) references app.unit (workspace_id, id),
  foreign key (workspace_id, deposit_account_id) references app.ledger_account (workspace_id, id)
);
create index lease_unit on app.lease (workspace_id, unit_id, start_date);

create table app.lease_tenant (
  workspace_id  uuid not null,
  lease_id      uuid not null,
  tenant_id     uuid not null,
  primary key (workspace_id, lease_id, tenant_id),
  foreign key (workspace_id, lease_id) references app.lease (workspace_id, id) on delete cascade,
  foreign key (workspace_id, tenant_id) references app.tenant (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- RNT-04, RNT-05: the rent roll. One charge per period; paid, partial and overdue are derived.
-- ---------------------------------------------------------------------------------------------
create table app.rent_charge (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  lease_id      uuid not null,
  kind          text not null default 'rent' check (kind in ('rent', 'late_fee')),
  period_start  date not null,
  due_date      date not null,
  amount_minor  bigint not null check (amount_minor >= 0),
  waived_at     timestamptz,                           -- a waived charge isn't owed
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, lease_id, kind, period_start),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lease_id) references app.lease (workspace_id, id) on delete cascade
);
create index rent_charge_due on app.rent_charge (workspace_id, entity_id, due_date);

-- `deposit_spec` restores a line that existed before it was matched; null means the payment created the transaction.
create table app.rent_payment (
  workspace_id    uuid not null,
  id              uuid not null default gen_random_uuid(),
  entity_id       uuid not null,
  lease_id        uuid not null,
  transaction_id  uuid not null,
  amount_minor    bigint not null check (amount_minor > 0),
  source          text not null check (source in ('auto', 'manual')),
  deposit_spec    jsonb,
  created_by      uuid references app.app_user (id),
  created_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, transaction_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lease_id) references app.lease (workspace_id, id) on delete cascade,
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);
create index rent_payment_lease on app.rent_payment (workspace_id, lease_id);

-- ---------------------------------------------------------------------------------------------
-- RNT-10: security deposits. A liability, never income, until forfeited. The balance follows from the events.
-- ---------------------------------------------------------------------------------------------
create table app.security_deposit_event (
  workspace_id    uuid not null,
  id              uuid not null default gen_random_uuid(),
  entity_id       uuid not null,
  lease_id        uuid not null,
  kind            text not null check (kind in ('received', 'returned', 'forfeited')),
  event_date      date not null,
  amount_minor    bigint not null check (amount_minor > 0),
  transaction_id  uuid not null,
  deposit_spec    jsonb,
  source          text not null default 'manual' check (source in ('auto', 'manual')),
  notes           text check (length(notes) <= 500),
  created_by      uuid references app.app_user (id),
  created_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, transaction_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lease_id) references app.lease (workspace_id, id) on delete cascade,
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);
create index security_deposit_lease on app.security_deposit_event (workspace_id, lease_id);

-- ---------------------------------------------------------------------------------------------
-- RNT-07: shared expenses, split by percent, units or square footage.
-- ---------------------------------------------------------------------------------------------
create table app.allocation_rule (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  name          text not null check (length(name) between 1 and 200),
  basis         text not null check (basis in ('percent', 'units', 'sqft')),
  -- [{ propertyId, percentBps? }]: percentages are stored; units and square footage are read at use.
  targets       jsonb not null,
  archived_at   timestamptz,
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- RNT-08: mortgages. The schedule is computed from these terms; payments link to bank lines.
-- ---------------------------------------------------------------------------------------------
create table app.loan_schedule (
  workspace_id       uuid not null,
  id                 uuid not null default gen_random_uuid(),
  entity_id          uuid not null,
  property_id        uuid not null,
  loan_account_id    uuid not null,                     -- the mortgage account; principal reduces it
  name               text not null check (length(name) between 1 and 200),
  principal_minor    bigint not null check (principal_minor > 0),
  rate_bps           integer not null check (rate_bps between 0 and 5000),
  term_months        integer not null check (term_months between 1 and 600),
  first_payment_date date not null,
  escrow_taxes_minor bigint not null default 0 check (escrow_taxes_minor >= 0),
  escrow_insurance_minor bigint not null default 0 check (escrow_insurance_minor >= 0),
  archived_at        timestamptz,
  version            bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, loan_account_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id),
  foreign key (workspace_id, loan_account_id) references app.ledger_account (workspace_id, id)
);

create table app.loan_payment (
  workspace_id    uuid not null,
  id              uuid not null default gen_random_uuid(),
  entity_id       uuid not null,
  loan_id         uuid not null,
  number          integer not null check (number > 0),
  transaction_id  uuid not null,
  source          text not null check (source in ('auto', 'manual')),
  deposit_spec    jsonb,
  created_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, loan_id, number),
  unique (workspace_id, transaction_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, loan_id) references app.loan_schedule (workspace_id, id) on delete cascade,
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- RNT-09: depreciation. A helper for Schedule E, never in the ledger. The building, and each improvement.
-- ---------------------------------------------------------------------------------------------
create table app.depreciation_schedule (
  workspace_id     uuid not null,
  id               uuid not null default gen_random_uuid(),
  entity_id        uuid not null,
  property_id      uuid not null,
  name             text not null check (length(name) between 1 and 200),
  basis_minor      bigint not null check (basis_minor > 0),
  in_service_date  date not null,
  method           text not null default 'SL_27_5' check (method in ('SL_27_5', 'SL_39')),
  transaction_id   uuid,                                -- the improvement it came from
  version          bigint not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id) on delete cascade,
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete set null (transaction_id)
);

-- ---------------------------------------------------------------------------------------------
-- RNT-12, RNT-13, RNT-14: reminders, the maintenance log and per-property budgets.
-- ---------------------------------------------------------------------------------------------
create table app.rental_reminder (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  property_id   uuid,
  kind          text not null check (kind in ('insurance', 'property_tax', 'inspection', 'other')),
  title         text not null check (length(title) between 1 and 200),
  due_date      date not null,
  lead_days     integer not null default 30 check (lead_days between 0 and 365),
  done_at       timestamptz,
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id) on delete cascade
);

create table app.maintenance_log (
  workspace_id     uuid not null,
  id               uuid not null default gen_random_uuid(),
  entity_id        uuid not null,
  property_id      uuid not null,
  unit_id          uuid,
  issue            text not null check (length(issue) between 1 and 500),
  vendor           text check (length(vendor) <= 200),
  cost_minor       bigint check (cost_minor >= 0),
  status           text not null default 'open' check (status in ('open', 'scheduled', 'done')),
  reported_on      date not null,
  completed_on     date,
  attachment_ids   uuid[] not null default '{}',
  transaction_ids  uuid[] not null default '{}',
  notes            text check (length(notes) <= 2000),
  version          bigint not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id) on delete cascade,
  foreign key (workspace_id, unit_id) references app.unit (workspace_id, id)
);

create table app.property_budget (
  workspace_id               uuid not null,
  property_id                uuid not null,
  entity_id                  uuid not null,
  capex_reserve_per_unit_minor bigint not null default 0 check (capex_reserve_per_unit_minor >= 0),
  version                    bigint not null default 1,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (workspace_id, property_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id) on delete cascade
);

create table app.property_budget_line (
  workspace_id  uuid not null,
  property_id   uuid not null,
  entity_id     uuid not null,
  category_id   uuid not null,
  amount_minor  bigint not null check (amount_minor >= 0),    -- planned per month
  primary key (workspace_id, property_id, category_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id) on delete cascade,
  foreign key (workspace_id, category_id) references app.ledger_account (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Existing kinds extended.
-- ---------------------------------------------------------------------------------------------
alter table app.insight drop constraint insight_kind_check;
alter table app.insight add constraint insight_kind_check
  check (kind in ('recurring', 'unusual_amount', 'duplicate_charge', 'new_subscription', 'price_increase', 'separation', 'capital_improvement'));

alter table app.transaction drop constraint transaction_source_check;
alter table app.transaction add constraint transaction_source_check
  check (source in ('manual', 'camera', 'import', 'receipt', 'payslip', 'recurring', 'system', 'feed', 'invoice', 'bill', 'rent', 'security_deposit', 'loan'));

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['property', 'unit', 'tenant', 'lease', 'rent_charge', 'allocation_rule', 'loan_schedule', 'depreciation_schedule', 'rental_reminder', 'maintenance_log', 'property_budget'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()', t || '_audit', t);
  end loop;
  foreach t in array array['property', 'unit', 'lease', 'rent_charge', 'rent_payment', 'maintenance_log'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.record_change()', t || '_change', t);
  end loop;
  foreach t in array array['property', 'unit', 'tenant', 'lease', 'lease_tenant', 'rent_charge', 'rent_payment', 'security_deposit_event', 'allocation_rule', 'loan_schedule', 'loan_payment', 'depreciation_schedule', 'rental_reminder', 'maintenance_log', 'property_budget', 'property_budget_line'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
  foreach t in array array['property', 'unit', 'tenant', 'lease', 'rent_charge', 'rent_payment', 'security_deposit_event', 'allocation_rule', 'loan_schedule', 'loan_payment', 'depreciation_schedule', 'rental_reminder', 'maintenance_log', 'property_budget', 'property_budget_line'] loop
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_write', t);
  end loop;
end $$;

-- Who's on a lease follows the lease.
create policy lease_tenant_select on app.lease_tenant for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.lease l where l.workspace_id = lease_tenant.workspace_id and l.id = lease_tenant.lease_id
                     and app.can_read_entity(l.entity_id)));
create policy lease_tenant_write on app.lease_tenant for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.lease l where l.workspace_id = lease_tenant.workspace_id and l.id = lease_tenant.lease_id
                     and app.can_write_entity(l.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.lease l where l.workspace_id = lease_tenant.workspace_id and l.id = lease_tenant.lease_id
                     and app.can_write_entity(l.entity_id)));

grant select, insert, update, delete on app.property, app.unit, app.tenant, app.lease, app.lease_tenant, app.rent_charge,
  app.rent_payment, app.security_deposit_event, app.allocation_rule, app.loan_schedule, app.loan_payment,
  app.depreciation_schedule, app.rental_reminder, app.maintenance_log, app.property_budget, app.property_budget_line to montra_app;
