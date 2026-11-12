-- Rentals: tenant details, the other people on a lease, lease set-up costs and property contacts (RNT-17..22; ADR-0038).
-- Tenants gain the details a landlord keeps on file; a lease names its co-signers and occupants beside the tenants who
-- sign and pay; a broker's fee and legal fees post as expenses tagged to the property; and each portfolio keeps its
-- contacts (manager, insurer, HOA, utilities…) linked to the properties they serve. US scope.

-- ---------------------------------------------------------------------------------------------
-- RNT-17: tenant details. No SSN is collected (ADR-0038 §1). The date of birth is sealed under the workspace key, as
-- payroll seals one (ADR-0034 §3), and shown masked; the rest is ordinary contact data under the portfolio's RLS.
-- ---------------------------------------------------------------------------------------------
alter table app.tenant
  add column birth_date_enc         bytea,
  add column phone_alt              text check (length(phone_alt) <= 50),
  add column mailing_address        text check (length(mailing_address) <= 1000),
  add column emergency_name         text check (length(emergency_name) <= 200),
  add column emergency_relationship text check (length(emergency_relationship) <= 100),
  add column emergency_phone        text check (length(emergency_phone) <= 50),
  -- Screening notes, optional.
  add column employer               text check (length(employer) <= 200),
  add column monthly_income_minor   bigint check (monthly_income_minor >= 0),
  add column vehicle                text check (length(vehicle) <= 200);

-- ---------------------------------------------------------------------------------------------
-- RNT-21: contacts of a rental portfolio, each linked to any number of its properties (one insurer for many).
-- Declared before the lease changes, which point at a broker here.
-- ---------------------------------------------------------------------------------------------
create table app.rental_contact (
  workspace_id    uuid not null,
  id              uuid not null default gen_random_uuid(),
  entity_id       uuid not null,
  role            text not null check (role in (
                    'property_manager', 'handyman', 'insurance', 'home_warranty', 'hoa', 'landscaping', 'broker',
                    'attorney', 'water', 'electricity', 'gas', 'garbage', 'internet', 'other')),
  company_name    text not null check (length(company_name) between 1 and 200),
  contact_person  text check (length(contact_person) <= 200),
  website         text check (length(website) <= 500),
  email           text check (length(email) <= 320),
  phone           text check (length(phone) <= 50),
  -- An account, policy or membership number, as the company quotes it.
  account_number  text check (length(account_number) <= 100),
  notes           text check (length(notes) <= 2000),
  archived_at     timestamptz,
  version         bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);
create index rental_contact_entity on app.rental_contact (workspace_id, entity_id, role);

create table app.rental_contact_property (
  workspace_id  uuid not null,
  contact_id    uuid not null,
  property_id   uuid not null,
  entity_id     uuid not null,
  primary key (workspace_id, contact_id, property_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, contact_id) references app.rental_contact (workspace_id, id) on delete cascade,
  foreign key (workspace_id, property_id) references app.property (workspace_id, id) on delete cascade
);
create index rental_contact_property_property on app.rental_contact_property (workspace_id, property_id);

-- The maintenance log's vendor can be a contact; the free text stays for anyone not kept as one.
alter table app.maintenance_log add column contact_id uuid;
alter table app.maintenance_log
  add foreign key (workspace_id, contact_id) references app.rental_contact (workspace_id, id);

-- ---------------------------------------------------------------------------------------------
-- RNT-18: the people on a lease who don't sign as tenants. `lease_tenant` stays the tenants who sign and pay, so rent,
-- arrears and matching keep reading only payers (ADR-0038 §2). A co-signer (guarantor) may be one of the portfolio's
-- tenants; an occupant is a household member named on the lease, with a sealed date of birth like a tenant's.
-- ---------------------------------------------------------------------------------------------
create table app.lease_person (
  workspace_id     uuid not null,
  id               uuid not null default gen_random_uuid(),
  entity_id        uuid not null,
  lease_id         uuid not null,
  role             text not null check (role in ('cosigner', 'occupant')),
  tenant_id        uuid,
  name             text check (length(name) between 1 and 200),
  relationship     text check (length(relationship) <= 100),
  email            text check (length(email) <= 320),
  phone            text check (length(phone) <= 50),
  mailing_address  text check (length(mailing_address) <= 1000),
  birth_date_enc   bytea,
  notes            text check (length(notes) <= 2000),
  sort_order       integer not null default 0,
  version          bigint not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (workspace_id, id),
  check (tenant_id is not null or name is not null),
  check (role = 'cosigner' or tenant_id is null),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lease_id) references app.lease (workspace_id, id) on delete cascade,
  foreign key (workspace_id, tenant_id) references app.tenant (workspace_id, id)
);
create index lease_person_lease on app.lease_person (workspace_id, lease_id);
create index lease_person_tenant on app.lease_person (workspace_id, tenant_id) where tenant_id is not null;

-- ---------------------------------------------------------------------------------------------
-- RNT-19: a lease's broker or agent, and what it cost to set up. A broker's fee posts to Commissions (Schedule E line 8)
-- and legal or document fees to Legal & professional (line 10), tagged to the property and unit (RNT-06). The lease
-- owns the transaction, as it owns rent; removing the cost gives a taken-over bank line back as it was.
-- ---------------------------------------------------------------------------------------------
alter table app.lease add column broker_contact_id uuid;
alter table app.lease
  add foreign key (workspace_id, broker_contact_id) references app.rental_contact (workspace_id, id);

create table app.lease_cost (
  workspace_id    uuid not null,
  id              uuid not null default gen_random_uuid(),
  entity_id       uuid not null,
  lease_id        uuid not null,
  kind            text not null check (kind in ('broker_fee', 'legal_fee')),
  contact_id      uuid,
  amount_minor    bigint not null check (amount_minor > 0),
  transaction_id  uuid not null,
  -- What a taken-over bank line was before, to give it back; null when recording the cost created it.
  previous_spec   jsonb,
  notes           text check (length(notes) <= 500),
  created_by      uuid references app.app_user (id),
  created_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lease_id) references app.lease (workspace_id, id) on delete cascade,
  foreign key (workspace_id, contact_id) references app.rental_contact (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);
create index lease_cost_lease on app.lease_cost (workspace_id, lease_id);

-- ---------------------------------------------------------------------------------------------
-- RNT-20: "HOA dues" and "Home warranty" rental expense categories, on Schedule E line 19 (Other). New portfolios get them
-- from the chart template; this adds them to the rental books that exist, beside the other rental expenses, unless a
-- category of that name is already there (whatever its case, archived or not). Running it again adds nothing.
-- ---------------------------------------------------------------------------------------------
create function app.add_rental_categories(p_workspace uuid, p_entity uuid) returns integer
  language plpgsql
  set search_path = pg_catalog
as $$
declare
  added integer := 0;
  n integer;
  c record;
begin
  for c in select * from (values ('HOA dues'), ('Home warranty')) as v(name) loop
    insert into app.ledger_account (workspace_id, entity_id, type, subtype, name, currency, is_category,
                                    category_group_id, tax_line_code, sort_order)
    select e.workspace_id, e.id, 'expense', 'category', c.name, e.functional_currency, true,
           g.id, 'US_SCH_E_L19',
           coalesce((select max(a.sort_order) + 1 from app.ledger_account a
                      where a.workspace_id = e.workspace_id and a.entity_id = e.id
                        and a.category_group_id is not distinct from g.id and a.is_category), 0)
      from app.entity e
      left join lateral (select cg.id from app.category_group cg
                          where cg.workspace_id = e.workspace_id and cg.entity_id = e.id and cg.kind = 'rental'
                          order by cg.sort_order, cg.created_at limit 1) g on true
     where e.workspace_id = p_workspace and e.id = p_entity and e.type = 'rental'
       and not exists (select 1 from app.ledger_account a
                        where a.workspace_id = e.workspace_id and a.entity_id = e.id and a.is_category
                          and lower(a.name) = lower(c.name));
    get diagnostics n = row_count;
    added := added + n;
  end loop;
  return added;
end $$;
revoke all on function app.add_rental_categories(uuid, uuid) from public;
grant execute on function app.add_rental_categories(uuid, uuid) to montra_app;

select app.add_rental_categories(e.workspace_id, e.id) from app.entity e where e.type = 'rental';

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants, as for the portfolio's other records: readers see them, writers change them.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['rental_contact', 'lease_person'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
  end loop;
  -- A contact's links to properties are audited through the contact, as a lease's tenants are through the lease.
  foreach t in array array['rental_contact', 'lease_person', 'lease_cost'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()', t || '_audit', t);
  end loop;
  foreach t in array array['rental_contact', 'rental_contact_property', 'lease_person', 'lease_cost'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_write', t);
  end loop;
end $$;

grant select, insert, update, delete on app.rental_contact, app.rental_contact_property, app.lease_person,
  app.lease_cost to montra_app;
