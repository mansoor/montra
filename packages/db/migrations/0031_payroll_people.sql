-- Payroll, stage 1: people and their onboarding forms (PRL-01..05; ADR-0034).
-- Everything is scoped to one business. Personal data is readable only by people who can write to the business, so a
-- read-only accountant or a household partner without a grant sees none of it. SSNs, TINs, dates of birth, document
-- numbers and bank details are `_enc` columns sealed by FieldCrypto; the audit trigger redacts them.

-- ---------------------------------------------------------------------------------------------
-- Files whose bytes are sealed with the workspace data key before they reach storage (copies of identity documents).
-- `sha256` and `bytes` describe the plain file, so a backup, which decrypts them, still checks out.
-- ---------------------------------------------------------------------------------------------
alter table app.file add column sealed boolean not null default false;

-- ---------------------------------------------------------------------------------------------
-- PRL-01: employees and contractors.
-- ---------------------------------------------------------------------------------------------
create table app.payroll_person (
  workspace_id       uuid not null,
  id                 uuid not null default gen_random_uuid(),
  entity_id          uuid not null,
  kind               text not null check (kind in ('employee', 'contractor')),
  first_name         text not null check (length(first_name) between 1 and 100),
  middle_name        text check (length(middle_name) <= 100),
  last_name          text not null check (length(last_name) between 1 and 100),
  -- A contractor's business, as it should appear on a 1099.
  business_name      text check (length(business_name) <= 200),
  email              text check (length(email) <= 320),
  phone              text check (length(phone) <= 50),
  address_line1      text check (length(address_line1) <= 200),
  address_line2      text check (length(address_line2) <= 200),
  city               text check (length(city) <= 100),
  region             text check (length(region) <= 50),             -- a US state code for US addresses
  postal_code        text check (length(postal_code) <= 20),
  country            text not null default 'US' check (country ~ '^[A-Z]{2}$'),
  tin_type           text check (tin_type in ('ssn', 'itin', 'ein')),
  tin_enc            bytea,
  tin_last4          text check (tin_last4 ~ '^[0-9]{4}$'),
  birth_date_enc     bytea,
  hire_date          date,
  end_date           date,
  pay_type           text check (pay_type in ('hourly', 'salary')),
  -- Per hour for hourly pay, per year for salary.
  rate_minor         bigint check (rate_minor >= 0),
  work_state         text check (work_state ~ '^[A-Z]{2}$'),
  bank_routing_enc   bytea,
  bank_account_enc   bytea,
  bank_account_type  text check (bank_account_type in ('checking', 'savings')),
  bank_last4         text check (bank_last4 ~ '^[0-9]{4}$'),
  -- A contractor is paid through bills (BIZ-06, PRL-10) to this vendor.
  vendor_party_id    uuid,
  notes              text check (length(notes) <= 2000),
  version            bigint not null default 1,
  created_by         uuid references app.app_user (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, id),
  check (end_date is null or hire_date is null or end_date >= hire_date),
  check ((tin_enc is null) = (tin_last4 is null)),
  check ((bank_account_enc is null) = (bank_last4 is null)),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, vendor_party_id) references app.business_party (workspace_id, id)
);
create index payroll_person_entity on app.payroll_person (workspace_id, entity_id, kind, last_name);

-- ---------------------------------------------------------------------------------------------
-- PRL-02: Form W-4, 2020 and later. A new one supersedes the last from its effective date; a form is never edited.
-- Name, address and TIN are kept as signed.
-- ---------------------------------------------------------------------------------------------
create table app.payroll_w4 (
  workspace_id             uuid not null,
  id                       uuid not null default gen_random_uuid(),
  entity_id                uuid not null,
  person_id                uuid not null,
  effective_date           date not null,
  legal_name               text not null check (length(legal_name) between 1 and 300),
  address                  text check (length(address) <= 1000),
  tin_enc                  bytea,
  tin_last4                text check (tin_last4 ~ '^[0-9]{4}$'),
  filing_status            text not null check (filing_status in ('single', 'married_jointly', 'head_of_household')),
  multiple_jobs            boolean not null default false,             -- Step 2(c)
  dependents_minor         bigint not null default 0 check (dependents_minor >= 0),          -- Step 3
  other_income_minor       bigint not null default 0 check (other_income_minor >= 0),        -- Step 4(a)
  deductions_minor         bigint not null default 0 check (deductions_minor >= 0),          -- Step 4(b)
  extra_withholding_minor  bigint not null default 0 check (extra_withholding_minor >= 0),   -- Step 4(c), per pay period
  exempt                   boolean not null default false,
  signed_name              text not null check (length(signed_name) between 1 and 300),
  signed_on                date not null,
  created_by               uuid references app.app_user (id),
  created_at               timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, person_id, effective_date),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- PRL-03: Form W-9 (Rev. March 2024), from a contractor.
-- ---------------------------------------------------------------------------------------------
create table app.payroll_w9 (
  workspace_id           uuid not null,
  id                     uuid not null default gen_random_uuid(),
  entity_id              uuid not null,
  person_id              uuid not null,
  legal_name             text not null check (length(legal_name) between 1 and 300),       -- line 1
  business_name          text check (length(business_name) <= 300),                        -- line 2
  tax_classification     text not null check (tax_classification in ('individual', 'c_corporation', 's_corporation',
                           'partnership', 'trust_estate', 'llc_c', 'llc_s', 'llc_p', 'other')),  -- line 3a
  other_classification   text check (length(other_classification) <= 100),
  foreign_partners       boolean not null default false,                                    -- line 3b
  exempt_payee_code      text check (length(exempt_payee_code) <= 4),                       -- line 4
  fatca_code             text check (length(fatca_code) <= 4),
  address                text not null check (length(address) between 1 and 1000),        -- lines 5 and 6
  account_numbers        text check (length(account_numbers) <= 200),                      -- line 7
  tin_type               text not null check (tin_type in ('ssn', 'itin', 'ein')),
  tin_enc                bytea not null,
  tin_last4              text not null check (tin_last4 ~ '^[0-9]{4}$'),
  -- Part II item 2 crossed out: the IRS said they are subject to backup withholding.
  backup_withholding     boolean not null default false,
  signed_name            text not null check (length(signed_name) between 1 and 300),
  signed_on              date not null,
  created_by             uuid references app.app_user (id),
  created_at             timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id) on delete cascade
);
create index payroll_w9_person on app.payroll_w9 (workspace_id, person_id, signed_on desc);

-- ---------------------------------------------------------------------------------------------
-- PRL-04: Form I-9 (Edition 01/20/25). Section 1 is the employee's, Section 2 the employer's. Retention runs to the later
-- of 3 years after hire and 1 year after the job ends, worked out from the person's dates on read (ADR-0034 §5).
-- ---------------------------------------------------------------------------------------------
create table app.payroll_i9 (
  workspace_id               uuid not null,
  id                         uuid not null default gen_random_uuid(),
  entity_id                  uuid not null,
  person_id                  uuid not null,
  -- Section 1
  last_name                  text not null check (length(last_name) between 1 and 100),
  first_name                 text not null check (length(first_name) between 1 and 100),
  middle_initial             text check (length(middle_initial) <= 1),
  other_last_names           text check (length(other_last_names) <= 200),
  address                    text check (length(address) <= 200),
  apartment                  text check (length(apartment) <= 20),
  city                       text check (length(city) <= 100),
  state                      text check (state ~ '^[A-Z]{2}$'),
  zip                        text check (length(zip) <= 10),
  birth_date_enc             bytea,
  ssn_enc                    bytea,
  ssn_last4                  text check (ssn_last4 ~ '^[0-9]{4}$'),
  email                      text check (length(email) <= 320),
  phone                      text check (length(phone) <= 50),
  citizenship                text check (citizenship in ('citizen', 'noncitizen_national', 'permanent_resident',
                               'authorized_alien')),
  a_number_enc               bytea,          -- USCIS / A-number, for a permanent resident or an authorized alien
  work_until                 date,           -- an authorized alien's expiration date, if any
  i94_number_enc             bytea,
  passport_number_enc        bytea,
  passport_country           text check (length(passport_country) <= 100),
  employee_signed_name       text check (length(employee_signed_name) <= 300),
  employee_signed_on         date,
  -- Supplement A, one preparer or translator
  preparer_name              text check (length(preparer_name) <= 300),
  preparer_address           text check (length(preparer_address) <= 500),
  preparer_signed_on         date,
  -- Section 2
  first_day                  date,
  additional_info            text check (length(additional_info) <= 1000),
  employer_signed_name       text check (length(employer_signed_name) <= 300),
  employer_title             text check (length(employer_title) <= 100),
  employer_signed_on         date,
  employer_business_name     text check (length(employer_business_name) <= 300),
  employer_business_address  text check (length(employer_business_address) <= 500),
  version                    bigint not null default 1,
  created_by                 uuid references app.app_user (id),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, person_id),
  check ((ssn_enc is null) = (ssn_last4 is null)),
  check ((employee_signed_on is null) = (employee_signed_name is null)),
  check ((employer_signed_on is null) = (employer_signed_name is null)),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id) on delete cascade
);

-- The documents the employer examined: one from List A, or one each from Lists B and C. `file_ids` are sealed copies.
create table app.payroll_i9_document (
  workspace_id        uuid not null,
  id                  uuid not null default gen_random_uuid(),
  entity_id           uuid not null,
  i9_id               uuid not null,
  list                text not null check (list in ('A', 'B', 'C')),
  title               text not null check (length(title) between 1 and 200),
  issuing_authority   text check (length(issuing_authority) <= 200),
  number_enc          bytea,
  number_last4        text check (length(number_last4) <= 4),
  expires_on          date,
  file_ids            uuid[] not null default '{}',
  created_by          uuid references app.app_user (id),
  created_at          timestamptz not null default now(),
  primary key (workspace_id, id),
  check ((number_enc is null) = (number_last4 is null)),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, i9_id) references app.payroll_i9 (workspace_id, id) on delete cascade
);
create index payroll_i9_document_i9 on app.payroll_i9_document (workspace_id, i9_id);

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants. Personal data: reading needs write access to the business (ADR-0034 §2).
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['payroll_person', 'payroll_i9'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
  end loop;
  foreach t in array array['payroll_person', 'payroll_w4', 'payroll_w9', 'payroll_i9', 'payroll_i9_document'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()', t || '_audit', t);
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_all', t);
  end loop;
end $$;

grant select, insert, update, delete on app.payroll_person, app.payroll_w4, app.payroll_w9, app.payroll_i9,
  app.payroll_i9_document to montra_app;
