-- Staff time: vacation and California paid sick leave, daily overtime, contractor timesheets (PRL-23..29; ADR-0036).
-- Balances are a ledger of hours per person and kind. A pay run's accrual, use, yearly grant and payout are written when
-- it's approved and removed when it's reopened. Accrued vacation is never posted to the books (cash basis): only pay is.
-- Hours are thousandths (8 hours = 8000), as `paycheck_line.hours_milli`.

-- ---------------------------------------------------------------------------------------------
-- PRL-23, PRL-24: each business's vacation and sick leave policy. A business with no sick row uses California's minimum.
-- 'grant' is a yearly amount at the start of the calendar year (a front-loaded sick policy is a grant).
-- ---------------------------------------------------------------------------------------------
create table app.leave_policy (
  workspace_id         uuid not null,
  entity_id            uuid not null,
  kind                 text not null check (kind in ('vacation', 'sick')),
  method               text not null check (method in ('none', 'accrual', 'grant')),
  -- Accrual: `accrue_milli` earned for every `per_hours_milli` worked (1 hour per 30 = 1000 per 30000).
  accrue_milli         bigint check (accrue_milli > 0 and accrue_milli <= 1000000),
  per_hours_milli      bigint check (per_hours_milli > 0 and per_hours_milli <= 1000000),
  -- Grant: the hours given at the start of each year.
  grant_milli          bigint check (grant_milli >= 0 and grant_milli <= 1000000),
  -- No more accrues (or is granted) once the balance reaches this. Null: no cap.
  max_balance_milli    bigint check (max_balance_milli >= 0 and max_balance_milli <= 10000000),
  -- At the start of a year, the balance above this is forfeited. Null: everything carries over. Never applied to
  -- California vacation, which is wages once earned.
  carryover_max_milli  bigint check (carryover_max_milli >= 0 and carryover_max_milli <= 10000000),
  -- Using more than this in a year warns. Null: no limit.
  use_cap_milli        bigint check (use_cap_milli >= 0 and use_cap_milli <= 10000000),
  version              bigint not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (workspace_id, entity_id, kind),
  check (kind = 'vacation' or method <> 'none'),
  check (method <> 'accrual' or (accrue_milli is not null and per_hours_milli is not null)),
  check (method <> 'grant' or grant_milli is not null),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- PRL-25: the hours behind each balance. Opening balances and adjustments are entered; the rest come from a paycheck and
-- go with it when its run is reopened.
-- ---------------------------------------------------------------------------------------------
create table app.leave_entry (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  person_id     uuid not null,
  kind          text not null check (kind in ('vacation', 'sick')),
  entry_date    date not null,
  source        text not null check (source in ('opening', 'adjustment', 'accrual', 'grant', 'carryover', 'used',
                  'payout')),
  -- Signed: earned is positive; used, paid out and forfeited are negative.
  hours_milli   bigint not null check (hours_milli between -10000000 and 10000000),
  -- The year a grant or a carry-over cut belongs to, so each happens once a year.
  leave_year    integer check (leave_year between 2000 and 2100),
  paycheck_id   uuid,
  note          text check (length(note) <= 500),
  created_by    uuid references app.app_user (id),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  check ((source in ('opening', 'adjustment')) = (paycheck_id is null)),
  check ((source in ('grant', 'carryover')) = (leave_year is not null)),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id) on delete cascade,
  foreign key (workspace_id, paycheck_id) references app.paycheck (workspace_id, id) on delete cascade
);
create index leave_entry_person on app.leave_entry (workspace_id, person_id, kind, entry_date);
create index leave_entry_paycheck on app.leave_entry (workspace_id, paycheck_id) where paycheck_id is not null;
create unique index leave_entry_opening on app.leave_entry (workspace_id, person_id, kind) where source = 'opening';
create unique index leave_entry_year on app.leave_entry (workspace_id, person_id, kind, source, leave_year)
  where source in ('grant', 'carryover');

-- ---------------------------------------------------------------------------------------------
-- PRL-26, PRL-27: leave and daily hours on a paycheck. With a daily grid, regular, overtime and double-time hours are
-- worked out from it; otherwise they're entered as totals ('manual').
-- ---------------------------------------------------------------------------------------------
alter table app.paycheck
  add column vacation_hours_milli   bigint not null default 0 check (vacation_hours_milli between 0 and 1000000),
  add column sick_hours_milli       bigint not null default 0 check (sick_hours_milli between 0 and 1000000),
  add column vacation_payout_milli  bigint not null default 0 check (vacation_payout_milli between 0 and 10000000),
  add column overtime_method        text not null default 'manual' check (overtime_method in ('manual', 'daily')),
  -- The owner allowed using more leave than the balance on this paycheck.
  add column leave_over_allowed     boolean not null default false;

create table app.paycheck_day (
  workspace_id  uuid not null,
  entity_id     uuid not null,
  paycheck_id   uuid not null,
  work_date     date not null,
  hours_milli   bigint not null check (hours_milli between 0 and 24000),
  primary key (workspace_id, paycheck_id, work_date),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, paycheck_id) references app.paycheck (workspace_id, id) on delete cascade
);

-- The day a workweek starts, for weekly and seventh-day overtime: ISO weekday, 0 = Monday … 6 = Sunday.
alter table app.payroll_settings
  add column workweek_starts smallint not null default 6 check (workweek_starts between 0 and 6);

-- ---------------------------------------------------------------------------------------------
-- PRL-28: a contractor's hours. Billing them makes one bill to their vendor record; billed hours are locked while the
-- bill stands (a voided bill frees them).
-- ---------------------------------------------------------------------------------------------
create table app.contractor_time (
  workspace_id       uuid not null,
  id                 uuid not null default gen_random_uuid(),
  entity_id          uuid not null,
  person_id          uuid not null,
  work_date          date not null,
  hours_milli        bigint not null check (hours_milli > 0 and hours_milli <= 24000),
  note               text check (length(note) <= 500),
  -- A customer the hours were for, so they can be invoiced on.
  customer_party_id  uuid,
  -- The hourly rate the hours were billed at.
  rate_minor         bigint check (rate_minor >= 0),
  bill_id            uuid,
  version            bigint not null default 1,
  created_by         uuid references app.app_user (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.payroll_person (workspace_id, id) on delete cascade,
  foreign key (workspace_id, customer_party_id) references app.business_party (workspace_id, id),
  foreign key (workspace_id, bill_id) references app.bill (workspace_id, id) on delete set null (bill_id)
);
create index contractor_time_person on app.contractor_time (workspace_id, person_id, work_date desc);
create index contractor_time_bill on app.contractor_time (workspace_id, bill_id) where bill_id is not null;

-- Billed hours can't change or go while their bill stands; moving them to a new bill after a void is allowed.
create function app.contractor_time_locked() returns trigger
  language plpgsql set search_path = app, pg_temp as $$
begin
  if old.bill_id is not null
     and (tg_op = 'DELETE' or new.bill_id is not distinct from old.bill_id)
     and exists (select 1 from app.bill b
                  where b.workspace_id = old.workspace_id and b.id = old.bill_id and b.status <> 'void') then
    raise exception 'These hours are on a bill and can''t be changed'
      using errcode = 'check_violation', constraint = 'contractor_time_billed';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function app.contractor_time_locked() from public;
grant execute on function app.contractor_time_locked() to montra_app;
create trigger contractor_time_locked before update or delete on app.contractor_time
  for each row execute function app.contractor_time_locked();

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants. Leave and daily hours are read with the pay they belong to (read access to the business, as
-- for paychecks); a contractor's hours are a personal record (write access, as for people).
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['leave_policy', 'contractor_time'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
  end loop;
  foreach t in array array['leave_policy', 'leave_entry', 'paycheck_day', 'contractor_time'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()', t || '_audit', t);
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
  foreach t in array array['leave_policy', 'leave_entry', 'paycheck_day'] loop
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_write', t);
  end loop;
  execute $f$create policy contractor_time_all on app.contractor_time for all
    using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
    with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$;
end $$;

grant select, insert, update, delete on app.leave_policy, app.leave_entry, app.paycheck_day, app.contractor_time
  to montra_app;
