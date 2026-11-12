-- A business's legal and tax setup and its registrations (BIZ-21..26; ADR-0037). The entity type says which federal
-- return the business files and how its owners are paid; the fiscal year sets its P&L year and Schedule C summary; the
-- federal, California and local registrations live on the business, with "renew by" reminders for those that expire.
-- The EIN, the EDD employer account and the filing address move here from payroll (migration 0033/0034), so payroll,
-- the year-end forms and the EFW2 file read the business's own record.

-- ---------------------------------------------------------------------------------------------
-- BIZ-21: entity types. An LLC's tax treatment is part of its type: a single-member LLC is a sole proprietorship for
-- tax unless it elected S-corp treatment (Form 2553); a multi-member LLC is a partnership unless it did. The old 'llc'
-- (members unknown) and 'other' stay valid, so a business saved before this keeps its type until the owner picks one.
-- ---------------------------------------------------------------------------------------------
alter table app.entity drop constraint entity_business_type_check;
alter table app.entity add constraint entity_business_type_check check (business_type in (
  'sole_prop', 'single_member_llc', 'single_member_llc_s_corp', 'multi_member_llc', 'multi_member_llc_s_corp',
  'partnership', 's_corp', 'c_corp', 'llc', 'other'));

-- ---------------------------------------------------------------------------------------------
-- BIZ-22..24: registrations on the business. Numbers that are on every form the business sends (EIN, state account
-- numbers) are kept as text, as payroll kept the EIN (ADR-0034 §7), and shown masked; see ADR-0037 §5.
-- ---------------------------------------------------------------------------------------------
alter table app.business_profile
  -- Form 2553's effective date, for the S-corp types.
  add column s_corp_election_date    date,
  -- Federal.
  add column ein                     text check (ein ~ '^[0-9]{9}$'),
  add column irs_name                text check (length(irs_name) <= 200),
  add column naics_code              text check (naics_code ~ '^[0-9]{2,6}$'),
  -- State of formation. In California the Secretary of State's entity (file) number; the FTB's own ID where it has one.
  add column formation_state         text check (formation_state ~ '^[A-Z]{2}$'),
  add column sos_entity_number       text check (length(sos_entity_number) <= 30),
  add column formation_date          date,
  add column ftb_entity_id           text check (length(ftb_entity_id) <= 30),
  -- The EDD employer payroll tax account number, 8 digits (was payroll_settings.ca_employer_account).
  add column ca_employer_account     text check (ca_employer_account ~ '^[0-9]{8}$'),
  add column cdtfa_permit            text check (length(cdtfa_permit) <= 30),
  add column registered_agent_name   text check (length(registered_agent_name) <= 200),
  add column registered_agent_address text check (length(registered_agent_address) <= 1000),
  -- Local: the fictitious business name statement (DBA), filed with a county, expires after five years in California.
  add column dba_name                text check (length(dba_name) <= 200),
  add column dba_county              text check (length(dba_county) <= 60),
  add column dba_expires_on          date,
  add column city_license_number     text check (length(city_license_number) <= 50),
  add column city_license_expires_on date,
  -- The address the IRS and SSA have, in parts, for W-2s, 1099s and the EFW2 file (was payroll_settings.filing_*).
  add column filing_line1            text check (length(filing_line1) <= 100),
  add column filing_line2            text check (length(filing_line2) <= 100),
  add column filing_city             text check (length(filing_city) <= 60),
  add column filing_state            text check (filing_state ~ '^[A-Z]{2}$'),
  add column filing_zip              text check (filing_zip ~ '^[0-9]{5}([0-9]{4})?$');

-- Copy what payroll already has. A value already on the business wins; payroll's columns stay, unread, until a later
-- contract step drops them (ADR-0037 §3).
insert into app.business_profile as b (workspace_id, entity_id, ein, ca_employer_account,
                                       filing_line1, filing_line2, filing_city, filing_state, filing_zip)
select s.workspace_id, s.entity_id, s.ein, s.ca_employer_account,
       s.filing_line1, s.filing_line2, s.filing_city, s.filing_state, s.filing_zip
  from app.payroll_settings s
 where s.ein is not null or s.ca_employer_account is not null or s.filing_line1 is not null
on conflict (workspace_id, entity_id) do update set
  ein                 = coalesce(b.ein, excluded.ein),
  ca_employer_account = coalesce(b.ca_employer_account, excluded.ca_employer_account),
  filing_line1        = case when b.filing_line1 is null then excluded.filing_line1 else b.filing_line1 end,
  filing_line2        = case when b.filing_line1 is null then excluded.filing_line2 else b.filing_line2 end,
  filing_city         = case when b.filing_line1 is null then excluded.filing_city else b.filing_city end,
  filing_state        = case when b.filing_line1 is null then excluded.filing_state else b.filing_state end,
  filing_zip          = case when b.filing_line1 is null then excluded.filing_zip else b.filing_zip end;

comment on column app.payroll_settings.ein is 'Unused since 0037: the EIN is app.business_profile.ein.';
comment on column app.payroll_settings.ca_employer_account is
  'Unused since 0037: the EDD account is app.business_profile.ca_employer_account.';
comment on column app.payroll_settings.filing_line1 is
  'Unused since 0037, with filing_line2, filing_city, filing_state and filing_zip: see app.business_profile.filing_*.';

-- ---------------------------------------------------------------------------------------------
-- BIZ-24: any other registration (a county health permit, a professional licence, another state's account).
-- ---------------------------------------------------------------------------------------------
create table app.business_registration (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  label         text not null check (length(label) between 1 and 200),
  number        text check (length(number) <= 100),
  issuer        text check (length(issuer) <= 200),
  expires_on    date,
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);
create index business_registration_entity on app.business_registration (workspace_id, entity_id);

-- ---------------------------------------------------------------------------------------------
-- BIZ-25: the owner on payroll. Whether they may be a W-2 employee depends on the entity type (ADR-0037 §4).
-- ---------------------------------------------------------------------------------------------
alter table app.payroll_person add column is_owner boolean not null default false;

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants, as for the business's other records: readers see them, writers change them.
-- ---------------------------------------------------------------------------------------------
create trigger business_registration_touch before update on app.business_registration
  for each row execute function app.touch_versioned();
create trigger business_registration_audit after insert or update or delete on app.business_registration
  for each row execute function app.audit_row();
alter table app.business_registration enable row level security;
alter table app.business_registration force row level security;
create policy business_registration_select on app.business_registration for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy business_registration_write on app.business_registration for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

grant select, insert, update, delete on app.business_registration to montra_app;
