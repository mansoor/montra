-- Payroll, stage 2: pay schedules, pay runs and paychecks, and reimbursements (PRL-06..11; ADR-0034 §6–8).
-- A paycheck posts when its run is approved: wages and reimbursements as expenses, what was withheld as liabilities,
-- and net pay from the run's bank account. The employer's own taxes are worked out here and post when deposited.
-- Pay runs and paychecks can be read with read access to the business (an accountant sees pay, not personal data).

-- ---------------------------------------------------------------------------------------------
-- PRL-06: how often people are paid.
-- ---------------------------------------------------------------------------------------------
create table app.pay_schedule (
  workspace_id         uuid not null,
  id                   uuid not null default gen_random_uuid(),
  entity_id            uuid not null,
  name                 text not null check (length(name) between 1 and 100),
  frequency            text not null check (frequency in ('biweekly', 'semimonthly', 'monthly')),
  -- Every two weeks: the first day of any one period. Twice a month runs 1–15 and 16–end; monthly the whole month.
  anchor_date          date not null,
  -- Payday is this many days after the period ends.
  pay_lag_days         integer not null default 0 check (pay_lag_days between 0 and 31),
  pay_from_account_id  uuid,
  archived_at          timestamptz,
  version              bigint not null default 1,
  created_by           uuid references app.app_user (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, pay_from_account_id) references app.ledger_account (workspace_id, id)
);

alter table app.payroll_person add column pay_schedule_id uuid;
-- Hours an hourly employee usually works in a period, to start each paycheck from (80 hours = 80000).
alter table app.payroll_person add column default_hours_milli bigint check (default_hours_milli >= 0);
alter table app.payroll_person
  add constraint payroll_person_schedule foreign key (workspace_id, pay_schedule_id)
  references app.pay_schedule (workspace_id, id) on delete set null (pay_schedule_id);

-- ---------------------------------------------------------------------------------------------
-- PRL-07, PRL-09: pay runs and their paychecks. Totals are kept on the paycheck so lists and worksheets don't add up
-- lines; the check keeps them honest.
-- ---------------------------------------------------------------------------------------------
create table app.pay_run (
  workspace_id         uuid not null,
  id                   uuid not null default gen_random_uuid(),
  entity_id            uuid not null,
  schedule_id          uuid,
  period_start         date not null,
  period_end           date not null,
  pay_date             date not null,
  status               text not null default 'draft' check (status in ('draft', 'approved')),
  pay_from_account_id  uuid,
  -- Which tax engine filled in the taxes (ADR-0034 §7): 'manual' until stage 3's built-in one.
  engine               text not null default 'manual' check (length(engine) between 1 and 40),
  notes                text check (length(notes) <= 2000),
  approved_by          uuid references app.app_user (id),
  approved_at          timestamptz,
  version              bigint not null default 1,
  created_by           uuid references app.app_user (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (workspace_id, id),
  check (period_end >= period_start),
  check ((status = 'approved') = (approved_at is not null)),
  check (status = 'draft' or pay_from_account_id is not null),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, schedule_id) references app.pay_schedule (workspace_id, id),
  foreign key (workspace_id, pay_from_account_id) references app.ledger_account (workspace_id, id)
);
create unique index pay_run_period on app.pay_run (workspace_id, schedule_id, period_start) where schedule_id is not null;
create index pay_run_entity on app.pay_run (workspace_id, entity_id, pay_date desc);

create table app.paycheck (
  workspace_id            uuid not null,
  id                      uuid not null default gen_random_uuid(),
  entity_id               uuid not null,
  pay_run_id              uuid not null,
  person_id               uuid not null,
  -- As it was on the pay run: readers of the run can't see the person's record (ADR-0034 §2).
  person_name             text not null check (length(person_name) between 1 and 300),
  w4_id                   uuid,
  gross_minor             bigint not null default 0 check (gross_minor >= 0),
  pre_tax_minor           bigint not null default 0 check (pre_tax_minor >= 0),
  employee_taxes_minor    bigint not null default 0 check (employee_taxes_minor >= 0),
  post_tax_minor          bigint not null default 0 check (post_tax_minor >= 0),
  reimbursements_minor    bigint not null default 0 check (reimbursements_minor >= 0),
  net_minor               bigint not null default 0,
  employer_taxes_minor    bigint not null default 0 check (employer_taxes_minor >= 0),
  transaction_id          uuid,
  version                 bigint not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, pay_run_id, person_id),
  check (net_minor = gross_minor - pre_tax_minor - employee_taxes_minor - post_tax_minor + reimbursements_minor),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, pay_run_id) references app.pay_run (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id),
  foreign key (workspace_id, w4_id) references app.payroll_w4 (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);
create index paycheck_person on app.paycheck (workspace_id, person_id);

-- One line per earning, deduction, tax or reimbursement. Employer taxes are lines too, though they don't touch net pay.
create table app.paycheck_line (
  workspace_id      uuid not null,
  id                uuid not null default gen_random_uuid(),
  entity_id         uuid not null,
  paycheck_id       uuid not null,
  kind              text not null check (kind in ('earning', 'pre_tax_deduction', 'employee_tax', 'post_tax_deduction',
                      'reimbursement', 'employer_tax')),
  -- earning: regular, overtime, salary, bonus, commission, tips, other; employee_tax: fit, ss, medicare,
  -- addl_medicare, ca_pit, ca_sdi; employer_tax: ss_er, medicare_er, futa, ca_ui, ca_ett; deductions: free codes.
  code              text not null check (length(code) between 1 and 40),
  label             text not null check (length(label) between 1 and 100),
  hours_milli       bigint check (hours_milli >= 0),
  rate_minor        bigint check (rate_minor >= 0),
  amount_minor      bigint not null check (amount_minor >= 0),
  -- The wages this tax was worked out on.
  taxable_minor     bigint check (taxable_minor >= 0),
  source            text not null default 'manual' check (source in ('computed', 'manual')),
  reimbursement_id  uuid,
  sort_order        integer not null default 0,
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, paycheck_id) references app.paycheck (workspace_id, id) on delete cascade
);
create index paycheck_line_paycheck on app.paycheck_line (workspace_id, paycheck_id, sort_order);

-- ---------------------------------------------------------------------------------------------
-- PRL-11: reimbursements. Paid is worked out: the paycheck it's on was approved, or the bill it made was paid.
-- ---------------------------------------------------------------------------------------------
create table app.reimbursement (
  workspace_id        uuid not null,
  id                  uuid not null default gen_random_uuid(),
  entity_id           uuid not null,
  person_id           uuid not null,
  person_name         text not null check (length(person_name) between 1 and 300),
  spent_on            date not null,
  description         text not null check (length(description) between 1 and 500),
  amount_minor        bigint not null check (amount_minor > 0),
  currency            text not null,
  expense_account_id  uuid not null,
  file_ids            uuid[] not null default '{}',
  status              text not null default 'submitted' check (status in ('submitted', 'approved', 'declined')),
  pay_via             text check (pay_via in ('pay_run', 'bill')),
  decided_by          uuid references app.app_user (id),
  decided_at          timestamptz,
  decline_reason      text check (length(decline_reason) <= 500),
  paycheck_id         uuid,
  bill_id             uuid,
  version             bigint not null default 1,
  created_by          uuid references app.app_user (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (workspace_id, id),
  check ((status = 'approved') = (pay_via is not null)),
  check (bill_id is null or pay_via = 'bill'),
  check (paycheck_id is null or pay_via = 'pay_run'),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id),
  foreign key (workspace_id, expense_account_id) references app.ledger_account (workspace_id, id),
  foreign key (workspace_id, paycheck_id) references app.paycheck (workspace_id, id) on delete set null (paycheck_id),
  foreign key (workspace_id, bill_id) references app.bill (workspace_id, id) on delete set null (bill_id)
);
create index reimbursement_entity on app.reimbursement (workspace_id, entity_id, status, spent_on desc);

alter table app.paycheck_line
  add constraint paycheck_line_reimbursement foreign key (workspace_id, reimbursement_id)
  references app.reimbursement (workspace_id, id) on delete set null (reimbursement_id);

alter table app.transaction drop constraint transaction_source_check;
alter table app.transaction add constraint transaction_source_check
  check (source in ('manual', 'camera', 'import', 'receipt', 'payslip', 'recurring', 'system', 'feed', 'invoice', 'bill',
                    'rent', 'security_deposit', 'loan', 'payroll'));

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pay_schedule', 'pay_run', 'paycheck', 'reimbursement'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
  end loop;
  foreach t in array array['pay_schedule', 'pay_run', 'paycheck', 'paycheck_line', 'reimbursement'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()', t || '_audit', t);
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_write', t);
  end loop;
  foreach t in array array['pay_run', 'paycheck', 'reimbursement'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.record_change()', t || '_change', t);
  end loop;
end $$;

grant select, insert, update, delete on app.pay_schedule, app.pay_run, app.paycheck, app.paycheck_line,
  app.reimbursement to montra_app;

-- Your own storage (migration 0029) mirrors new files. A sealed copy of an identity document is ciphertext under the
-- workspace key, which the owner couldn't open from their storage, so it stays out of the mirror (ADR-0034 §3).
create or replace function app.storage_file_added() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare queued integer;
begin
  if new.kind = 'export' or new.sealed then return null; end if;
  insert into app.storage_mirror_item (workspace_id, destination_id, file_id)
  select d.workspace_id, d.id, new.id from app.storage_destination d
   where d.workspace_id = new.workspace_id and d.mirror_files and d.status <> 'paused' and new.kind = any (d.file_kinds)
  on conflict do nothing;
  get diagnostics queued = row_count;
  if queued > 0 then
    perform app.schedule_system_job('schedule', 'storage.mirror', now());
  end if;
  return null;
end $$;
revoke all on function app.storage_file_added() from public;
