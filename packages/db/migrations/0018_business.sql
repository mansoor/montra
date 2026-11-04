-- Phase 8: small business (BIZ-01..13, REC-09, AI-10; design 03 §8, 04 §13, ADR-0017).
-- Cash basis: invoices and bills post nothing until they're paid. Every table here is scoped to one entity, so a
-- household partner without a grant sees none of it. That includes customers' and vendors' contact details, which is
-- why they aren't on `app.payee` (workspace-wide).

-- ---------------------------------------------------------------------------------------------
-- Reference data (OPS-05): loaded by packages/db/src/reference, keyed by country (design 10, assumption 1).
-- ---------------------------------------------------------------------------------------------
create table ref.tax_line (
  country        text not null,
  code           text not null,                 -- what ledger_account.tax_line_code holds, e.g. US_SCH_C_L8
  form           text not null,                 -- schedule_c, schedule_e
  line           text not null,                 -- as printed: 8, 16b, 24a
  label          text not null,
  sort_order     integer not null,
  -- The share usually deductible (meals: half). A hint for the user, never a tax calculation.
  deductible_bps integer not null default 10000 check (deductible_bps between 0 and 10000),
  version        bigint not null default 1,
  updated_at     timestamptz not null default now(),
  primary key (country, code)
);

-- Rates can change mid-year (2022, 2026), so a rate applies from a date, not to a year.
create table ref.mileage_rate (
  country         text not null,
  effective_from  date not null,
  tenths_of_cent  integer not null check (tenths_of_cent > 0),  -- 72.5 cents = 725
  source          text not null,
  version         bigint not null default 1,
  updated_at      timestamptz not null default now(),
  primary key (country, effective_from)
);

grant select on ref.tax_line, ref.mileage_rate to montra_app;

-- ---------------------------------------------------------------------------------------------
-- BIZ-01: what a business needs beyond its entity row (type and fiscal year are on app.entity).
-- ---------------------------------------------------------------------------------------------
create table app.business_profile (
  workspace_id             uuid not null,
  entity_id                uuid not null,
  legal_name               text check (length(legal_name) <= 200),
  address                  text check (length(address) <= 1000),
  email                    text check (length(email) <= 320),   -- replies to invoices go here
  invoice_prefix           text not null default 'INV-' check (length(invoice_prefix) <= 20),
  next_invoice_number      integer not null default 1 check (next_invoice_number > 0),
  default_terms_days       integer not null default 30 check (default_terms_days between 0 and 365),
  default_deposit_account_id uuid,
  -- BIZ-09: the user's own effective rate; null until they enter one.
  tax_rate_bps             integer check (tax_rate_bps between 0 and 10000),
  tax_savings_account_id   uuid,
  -- BIZ-12: expenses over this without a receipt are listed.
  receipt_threshold_minor  bigint not null default 7500 check (receipt_threshold_minor >= 0),
  version                  bigint not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (workspace_id, entity_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, default_deposit_account_id) references app.ledger_account (workspace_id, id),
  foreign key (workspace_id, tax_savings_account_id) references app.ledger_account (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- BIZ-04: customers and vendors. Payees with activity are listed without a row here; one is created when the user
-- adds details or invoices them.
-- ---------------------------------------------------------------------------------------------
create table app.business_party (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  kind          text not null check (kind in ('customer', 'vendor')),
  name          text not null check (length(name) between 1 and 200),
  payee_key     text,                                -- how payments appear on statements
  email         text check (length(email) <= 320),
  phone         text check (length(phone) <= 50),
  address       text check (length(address) <= 1000),
  terms_days    integer check (terms_days between 0 and 365),
  notes         text check (length(notes) <= 2000),
  archived_at   timestamptz,
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);
create unique index business_party_key on app.business_party (workspace_id, entity_id, kind, payee_key)
  where payee_key is not null;

-- ---------------------------------------------------------------------------------------------
-- BIZ-05: invoices. Stored status is draft, sent or void; paid, partial and overdue follow from the payments and
-- the date, so they can't disagree with them.
-- ---------------------------------------------------------------------------------------------
create table app.invoice (
  workspace_id    uuid not null,
  id              uuid not null default gen_random_uuid(),
  entity_id       uuid not null,
  party_id        uuid not null,
  number          text not null check (length(number) between 1 and 40),
  status          text not null default 'draft' check (status in ('draft', 'sent', 'void')),
  issue_date      date not null,
  due_date        date not null,
  currency        text not null,
  subtotal_minor  bigint not null default 0 check (subtotal_minor >= 0),
  tax_minor       bigint not null default 0 check (tax_minor >= 0),
  total_minor     bigint not null default 0 check (total_minor >= 0),
  notes           text check (length(notes) <= 2000),
  pdf_file_id     uuid,                              -- what was sent, kept as sent
  sent_at         timestamptz,
  sent_to         text,
  version         bigint not null default 1,
  created_by      uuid references app.app_user (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, entity_id, number),
  check (due_date >= issue_date),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, party_id) references app.business_party (workspace_id, id),
  foreign key (workspace_id, pdf_file_id) references app.file (workspace_id, id)
);
create index invoice_open on app.invoice (workspace_id, entity_id, due_date) where status = 'sent';

create table app.invoice_line (
  workspace_id       uuid not null,
  id                 uuid not null default gen_random_uuid(),
  invoice_id         uuid not null,
  line_no            integer not null check (line_no > 0),
  description        text not null check (length(description) between 1 and 500),
  quantity_milli     bigint not null check (quantity_milli > 0),   -- 1.5 hours = 1500
  unit_price_minor   bigint not null check (unit_price_minor >= 0),
  tax_rate_bps       integer not null default 0 check (tax_rate_bps between 0 and 10000),
  amount_minor       bigint not null check (amount_minor >= 0),
  tax_minor          bigint not null check (tax_minor >= 0),
  income_account_id  uuid not null,
  primary key (workspace_id, id),
  unique (workspace_id, invoice_id, line_no),
  foreign key (workspace_id, invoice_id) references app.invoice (workspace_id, id) on delete cascade,
  foreign key (workspace_id, income_account_id) references app.ledger_account (workspace_id, id)
);

-- A deposit pays one invoice; an invoice can take several deposits. `deposit_spec` restores a deposit that existed
-- before it was matched; null means the payment created the transaction, and removing it removes the transaction.
create table app.invoice_payment (
  workspace_id    uuid not null,
  id              uuid not null default gen_random_uuid(),
  invoice_id      uuid not null,
  entity_id       uuid not null,
  transaction_id  uuid not null,
  amount_minor    bigint not null check (amount_minor > 0),
  source          text not null check (source in ('auto', 'manual')),
  deposit_spec    jsonb,
  created_by      uuid references app.app_user (id),
  created_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, transaction_id),
  foreign key (workspace_id, invoice_id) references app.invoice (workspace_id, id) on delete cascade,
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);
create index invoice_payment_invoice on app.invoice_payment (workspace_id, invoice_id);

-- ---------------------------------------------------------------------------------------------
-- BIZ-06: bills.
-- ---------------------------------------------------------------------------------------------
create table app.bill (
  workspace_id        uuid not null,
  id                  uuid not null default gen_random_uuid(),
  entity_id           uuid not null,
  party_id            uuid not null,
  reference           text check (length(reference) <= 100),
  status              text not null default 'open' check (status in ('open', 'paid', 'void')),
  bill_date           date not null,
  due_date            date not null,
  currency            text not null,
  amount_minor        bigint not null check (amount_minor > 0),
  expense_account_id  uuid not null,
  notes               text check (length(notes) <= 2000),
  attachment_ids      uuid[] not null default '{}',
  transaction_id      uuid,
  payment_source      text check (payment_source in ('auto', 'manual')),
  payment_spec        jsonb,                         -- as invoice_payment.deposit_spec
  version             bigint not null default 1,
  created_by          uuid references app.app_user (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (workspace_id, id),
  check (due_date >= bill_date),
  check ((status = 'paid') = (transaction_id is not null)),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, party_id) references app.business_party (workspace_id, id),
  foreign key (workspace_id, expense_account_id) references app.ledger_account (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);
create index bill_open on app.bill (workspace_id, entity_id, due_date) where status = 'open';

-- ---------------------------------------------------------------------------------------------
-- BIZ-07: mileage. A deduction, not a cash movement: it reaches Schedule C and never the ledger. The rate is kept on
-- the trip, so a later change to the table can't rewrite a past year.
-- ---------------------------------------------------------------------------------------------
create table app.mileage_trip (
  workspace_id     uuid not null,
  id               uuid not null default gen_random_uuid(),
  entity_id        uuid not null,
  trip_date        date not null,
  origin           text check (length(origin) <= 200),
  destination      text check (length(destination) <= 200),
  purpose          text not null check (length(purpose) between 1 and 500),
  vehicle          text check (length(vehicle) <= 100),
  miles_tenths     integer not null check (miles_tenths > 0),   -- 12.4 miles = 124
  tenths_of_cent   integer not null check (tenths_of_cent > 0),
  deduction_minor  bigint not null check (deduction_minor >= 0),
  version          bigint not null default 1,
  created_by       uuid references app.app_user (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);
create index mileage_trip_date on app.mileage_trip (workspace_id, entity_id, trip_date desc);

-- ---------------------------------------------------------------------------------------------
-- BIZ-11: a revenue target per budget period. REC-09 and BIZ-03 extend existing kinds.
-- ---------------------------------------------------------------------------------------------
alter table app.budget add column revenue_target_minor bigint check (revenue_target_minor is null or revenue_target_minor >= 0);

alter table app.recommendation drop constraint recommendation_type_check;
alter table app.recommendation add constraint recommendation_type_check
  check (type in ('REC-01', 'REC-02', 'REC-03', 'REC-04', 'REC-05', 'REC-06', 'REC-07', 'REC-08', 'REC-09', 'BIZ-09', 'BIZ-11'));

alter table app.insight drop constraint insight_kind_check;
alter table app.insight add constraint insight_kind_check
  check (kind in ('recurring', 'unusual_amount', 'duplicate_charge', 'new_subscription', 'price_increase', 'separation'));

alter table app.transaction drop constraint transaction_source_check;
alter table app.transaction add constraint transaction_source_check
  check (source in ('manual', 'camera', 'import', 'receipt', 'payslip', 'recurring', 'system', 'feed', 'invoice', 'bill'));

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['business_profile', 'business_party', 'invoice', 'bill', 'mileage_trip'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()', t || '_audit', t);
  end loop;
  foreach t in array array['business_party', 'invoice', 'bill', 'mileage_trip'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.record_change()', t || '_change', t);
  end loop;
  foreach t in array array['business_profile', 'business_party', 'invoice', 'invoice_line', 'invoice_payment', 'bill', 'mileage_trip'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
  foreach t in array array['business_profile', 'business_party', 'invoice', 'invoice_payment', 'bill', 'mileage_trip'] loop
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_write', t);
  end loop;
end $$;

-- Lines follow their invoice.
create policy invoice_line_select on app.invoice_line for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.invoice i where i.workspace_id = invoice_line.workspace_id and i.id = invoice_line.invoice_id
                     and app.can_read_entity(i.entity_id)));
create policy invoice_line_write on app.invoice_line for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.invoice i where i.workspace_id = invoice_line.workspace_id and i.id = invoice_line.invoice_id
                     and app.can_write_entity(i.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.invoice i where i.workspace_id = invoice_line.workspace_id and i.id = invoice_line.invoice_id
                     and app.can_write_entity(i.entity_id)));

grant select, insert, update, delete on app.business_profile, app.business_party, app.invoice, app.invoice_line,
  app.invoice_payment, app.bill, app.mileage_trip to montra_app;
