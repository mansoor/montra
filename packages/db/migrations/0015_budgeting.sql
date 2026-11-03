-- Phase 6: budgeting, money flow and recommendations (BUD-01..10, FLOW-01..07, REC-01..08, FAM-06/07, UP-11,
-- UP-14, TZ-04). See ADR-0015 (budget engine and read models); design 03 §4.4 and §7, 04 §8, §11, §12.

-- ---------------------------------------------------------------------------------------------
-- Budgets (BUD-01, BUD-05, FAM-06). One budget per entity (and optionally per member: a member budget is a
-- filter over the same activity). Periods are monthly by default, or weekly/biweekly anchored on a pay date.
-- ---------------------------------------------------------------------------------------------
create table app.budget (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  id              uuid not null default gen_random_uuid(),
  entity_id       uuid not null,
  member_id       uuid,                                  -- null = household budget
  name            text not null check (length(name) between 1 and 200),
  method          text not null default 'zero_based' check (method in ('zero_based', 'category_limits', 'light')),
  period_type     text not null default 'monthly' check (period_type in ('monthly', 'weekly', 'biweekly')),
  anchor_date     date,                                  -- weekly/biweekly: the first day of a period
  -- UP-11 light mode: "pay yourself first" savings per period; everything else is one line.
  savings_target_minor bigint check (savings_target_minor is null or savings_target_minor >= 0),
  archived_at     timestamptz,
  created_by      uuid references app.app_user (id),
  version         bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id),
  check (period_type = 'monthly' or anchor_date is not null)
);
create unique index budget_one_per_scope on app.budget
  (workspace_id, entity_id, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid)) where archived_at is null;

create table app.budget_period (
  workspace_id           uuid not null,
  id                     uuid not null default gen_random_uuid(),
  budget_id              uuid not null,
  start_date             date not null,
  end_date               date not null,
  -- BUD-03: expected take-home income for the period; null = derive from expected_income rows.
  expected_income_minor  bigint,
  status                 text not null default 'open' check (status in ('open', 'closed')),
  version                bigint not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, budget_id, start_date),
  foreign key (workspace_id, budget_id) references app.budget (workspace_id, id) on delete cascade,
  check (end_date >= start_date)
);

-- BUD-06: per category per period; the rollover mode is copied forward when a period is created.
create table app.budget_line (
  workspace_id      uuid not null,
  budget_period_id  uuid not null,
  category_id       uuid not null,
  assigned_minor    bigint not null default 0,
  rollover_mode     text not null default 'carry_surplus'
                      check (rollover_mode in ('carry_surplus', 'carry_deficit', 'carry_both', 'reset')),
  updated_at        timestamptz not null default now(),
  primary key (workspace_id, budget_period_id, category_id),
  foreign key (workspace_id, budget_period_id) references app.budget_period (workspace_id, id) on delete cascade
);

-- BUD-10: moves between categories (null = left to assign), kept as history.
create table app.budget_move (
  workspace_id      uuid not null,
  id                uuid not null default gen_random_uuid(),
  budget_period_id  uuid not null,
  from_category_id  uuid,
  to_category_id    uuid,
  amount_minor      bigint not null check (amount_minor > 0),
  note              text check (note is null or length(note) <= 500),
  moved_by          uuid references app.app_user (id),
  moved_at          timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, budget_period_id) references app.budget_period (workspace_id, id) on delete cascade,
  check (from_category_id is distinct from to_category_id)
);
create index budget_move_period on app.budget_move (workspace_id, budget_period_id, moved_at);

-- ---------------------------------------------------------------------------------------------
-- Goals and sinking funds (BUD-07, BUD-08, FAM-07). Debt payoff uses the liability accounts' rates and minimum
-- payments (bank_account.interest_rate_bps, min_payment_minor).
-- ---------------------------------------------------------------------------------------------
create table app.goal (
  workspace_id        uuid not null references app.workspace (id) on delete cascade,
  id                  uuid not null default gen_random_uuid(),
  entity_id           uuid not null,
  member_id           uuid,
  name                text not null check (length(name) between 1 and 200),
  type                text not null check (type in ('emergency_fund', 'debt_payoff', 'savings', 'sinking_fund')),
  target_minor        bigint check (target_minor is null or target_minor > 0),
  due_date            date,
  category_id         uuid,                               -- the budget category that funds it
  strategy            text check (strategy in ('snowball', 'avalanche')),
  linked_account_ids  uuid[] not null default '{}',       -- savings or debt accounts measured for progress
  extra_payment_minor bigint check (extra_payment_minor is null or extra_payment_minor >= 0),
  archived_at         timestamptz,
  created_by          uuid references app.app_user (id),
  version             bigint not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id),
  check (type <> 'sinking_fund' or (target_minor is not null and due_date is not null)),
  check (type <> 'debt_payoff' or strategy is not null)
);

alter table app.bank_account add column min_payment_minor bigint check (min_payment_minor is null or min_payment_minor >= 0);
-- FLOW-03: warn when the forecast balance falls below this (default 0).
alter table app.bank_account add column low_balance_minor bigint not null default 0;

-- ---------------------------------------------------------------------------------------------
-- Expected income (BUD-03): entered salaries, business revenue and rent; Phase 7 adds payslip patterns.
-- ---------------------------------------------------------------------------------------------
create table app.expected_income (
  workspace_id   uuid not null references app.workspace (id) on delete cascade,
  id             uuid not null default gen_random_uuid(),
  entity_id      uuid not null,
  member_id      uuid,
  name           text not null check (length(name) between 1 and 200),
  source_type    text not null check (source_type in ('salary', 'business', 'rent', 'other')),
  amount_minor   bigint not null check (amount_minor > 0),  -- take-home, in the deposit account's currency
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  cadence        text not null check (cadence in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly')),
  next_date      date not null,
  account_id     uuid,                                     -- where it lands (forecast)
  payee_key      text,                                     -- matches the arriving deposit (REC-03/04)
  active         boolean not null default true,
  version        bigint not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Recommendations (REC-01..08, 04 §12): computed in code, worded by AI; nothing applies without confirmation.
-- ---------------------------------------------------------------------------------------------
create table app.recommendation (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  budget_id     uuid,
  type          text not null check (type in ('REC-01', 'REC-02', 'REC-03', 'REC-04', 'REC-05', 'REC-06', 'REC-07', 'REC-08')),
  period_start  date not null,
  dedupe_key    text not null,                             -- e.g. 'REC-02:<category>:<period>'
  payload       jsonb not null,                            -- inputs, computed numbers, proposed actions
  wording       text,                                      -- AI summary of the payload (AIA-05: numbers from code)
  status        text not null default 'open' check (status in ('open', 'accepted', 'edited', 'dismissed', 'expired')),
  notified_at   timestamptz,
  resolved_at   timestamptz,
  resolved_by   uuid references app.app_user (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, dedupe_key),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, budget_id) references app.budget (workspace_id, id) on delete cascade
);
create index recommendation_open on app.recommendation (workspace_id, entity_id, created_at desc) where status = 'open';


-- Categories and accounts referenced by the planning tables are ledger accounts of the same workspace.
alter table app.budget_line add foreign key (workspace_id, category_id) references app.ledger_account (workspace_id, id) on delete cascade;
alter table app.budget_move add foreign key (workspace_id, from_category_id) references app.ledger_account (workspace_id, id) on delete cascade;
alter table app.budget_move add foreign key (workspace_id, to_category_id) references app.ledger_account (workspace_id, id) on delete cascade;
alter table app.goal add foreign key (workspace_id, category_id) references app.ledger_account (workspace_id, id) on delete set null (category_id);
alter table app.expected_income add foreign key (workspace_id, account_id) references app.ledger_account (workspace_id, id) on delete set null (account_id);

-- ---------------------------------------------------------------------------------------------
-- Read models (03 §4.4, ADR-0015). Maintained in the posting's own transaction by statement-level triggers
-- (one aggregated upsert per statement, from the transition tables), so they always reconcile to the
-- postings. Restricted (payslip) amounts keep their own rows and the same read rule as the entry.
-- ---------------------------------------------------------------------------------------------

-- Postings carry their entry's restricted member, so the read models need no join to journal_entry (which
-- is already gone while its postings are cascade-deleted).
alter table app.posting add column restricted_member_id uuid;

create or replace function app.posting_inherit_entry() returns trigger language plpgsql as $$
declare je record;
begin
  select entity_id, entry_date, restricted, restricted_member_id into je
    from app.journal_entry where workspace_id = new.workspace_id and id = new.journal_entry_id;
  if not found then
    raise exception 'journal entry % not found', new.journal_entry_id using errcode = 'foreign_key_violation';
  end if;
  new.entity_id := je.entity_id;
  new.entry_date := je.entry_date;
  new.restricted := je.restricted;
  new.restricted_member_id := je.restricted_member_id;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;

create or replace function app.journal_entry_propagate() returns trigger language plpgsql as $$
begin
  if new.entity_id is distinct from old.entity_id then
    raise exception 'a journal entry cannot move to another entity' using errcode = 'check_violation';
  end if;
  if new.entry_date is distinct from old.entry_date or new.restricted is distinct from old.restricted
     or new.restricted_member_id is distinct from old.restricted_member_id then
    update app.posting set entry_date = new.entry_date, restricted = new.restricted,
                           restricted_member_id = new.restricted_member_id
     where workspace_id = new.workspace_id and journal_entry_id = new.id;
  end if;
  return null;
end $$;

select set_config('app.allow_locked_edit', 'on', true);
update app.posting p set restricted_member_id = je.restricted_member_id
  from app.journal_entry je
 where je.workspace_id = p.workspace_id and je.id = p.journal_entry_id and je.restricted_member_id is not null;
select set_config('app.allow_locked_edit', '', true);

-- Keys use the zero uuid for "none" (Household; no restricted member) so they can be part of the key.
create table app.category_activity_monthly (
  workspace_id           uuid not null,
  entity_id              uuid not null,
  ledger_account_id      uuid not null,
  month                  date not null check (extract(day from month) = 1),
  member_key             uuid not null,           -- posting.member_id, zero = Household
  restricted             boolean not null,
  restricted_member_key  uuid not null,           -- posting.restricted_member_id, zero = none
  activity_minor         bigint not null,         -- Σ functional_amount_minor (debit positive)
  postings               integer not null,
  primary key (workspace_id, ledger_account_id, month, member_key, restricted, restricted_member_key)
);
create index category_activity_entity on app.category_activity_monthly (workspace_id, entity_id, month);

create table app.account_balance_daily (
  workspace_id            uuid not null,
  entity_id               uuid not null,
  ledger_account_id       uuid not null,
  date                    date not null,
  restricted              boolean not null,
  restricted_member_key   uuid not null,
  delta_minor             bigint not null,        -- account currency; balance = Σ delta through a date
  functional_delta_minor  bigint not null,
  primary key (workspace_id, ledger_account_id, date, restricted, restricted_member_key)
);
create index account_balance_entity on app.account_balance_daily (workspace_id, entity_id, date);

-- One function for the three triggers: the changed rows come from whichever transition tables exist (an
-- update contributes only the rows whose keys or amounts changed, so marking postings cleared costs nothing).
create function app.posting_read_models() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare
  cols constant text := 'workspace_id, entity_id, ledger_account_id, member_id, restricted, restricted_member_id, '
                        'entry_date, amount_minor, functional_amount_minor';
  src text;
begin
  src := case tg_op
    when 'INSERT' then format('select %s, 1 as sign from new_rows', cols)
    when 'DELETE' then format('select %s, -1 as sign from old_rows', cols)
    else format('select *, 1 as sign from (select %1$s from new_rows except all select %1$s from old_rows) n '
                'union all select *, -1 from (select %1$s from old_rows except all select %1$s from new_rows) o', cols)
  end;
  execute format($q$
    with changed as (
      select workspace_id, entity_id, ledger_account_id, entry_date, restricted, amount_minor, functional_amount_minor, sign,
             coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid) as mkey,
             coalesce(restricted_member_id, '00000000-0000-0000-0000-000000000000'::uuid) as rkey
        from (%s) c
    ), monthly as (
      insert into app.category_activity_monthly as m (workspace_id, entity_id, ledger_account_id, month, member_key,
                                                      restricted, restricted_member_key, activity_minor, postings)
      select workspace_id, entity_id, ledger_account_id, date_trunc('month', entry_date)::date, mkey, restricted, rkey,
             sum(sign * functional_amount_minor), sum(sign)
        from changed
       group by workspace_id, entity_id, ledger_account_id, date_trunc('month', entry_date), mkey, restricted, rkey
      on conflict (workspace_id, ledger_account_id, month, member_key, restricted, restricted_member_key) do update
        set activity_minor = m.activity_minor + excluded.activity_minor, postings = m.postings + excluded.postings
      returning 1
    )
    insert into app.account_balance_daily as d (workspace_id, entity_id, ledger_account_id, date, restricted,
                                                restricted_member_key, delta_minor, functional_delta_minor)
    select workspace_id, entity_id, ledger_account_id, entry_date, restricted, rkey,
           sum(sign * amount_minor), sum(sign * functional_amount_minor)
      from changed
     group by workspace_id, entity_id, ledger_account_id, entry_date, restricted, rkey
    on conflict (workspace_id, ledger_account_id, date, restricted, restricted_member_key) do update
      set delta_minor = d.delta_minor + excluded.delta_minor,
          functional_delta_minor = d.functional_delta_minor + excluded.functional_delta_minor
  $q$, src);
  return null;
end $$;

create trigger posting_read_models_ins after insert on app.posting
  referencing new table as new_rows for each statement execute function app.posting_read_models();
create trigger posting_read_models_upd after update on app.posting
  referencing old table as old_rows new table as new_rows for each statement execute function app.posting_read_models();
create trigger posting_read_models_del after delete on app.posting
  referencing old table as old_rows for each statement execute function app.posting_read_models();

-- Existing postings.
insert into app.category_activity_monthly (workspace_id, entity_id, ledger_account_id, month, member_key, restricted,
                                           restricted_member_key, activity_minor, postings)
select workspace_id, entity_id, ledger_account_id, date_trunc('month', entry_date)::date,
       coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid), restricted,
       coalesce(restricted_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
       sum(functional_amount_minor), count(*)
  from app.posting
 group by 1, 2, 3, 4, 5, 6, 7;
insert into app.account_balance_daily (workspace_id, entity_id, ledger_account_id, date, restricted, restricted_member_key,
                                       delta_minor, functional_delta_minor)
select workspace_id, entity_id, ledger_account_id, entry_date, restricted,
       coalesce(restricted_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
       sum(amount_minor), sum(functional_amount_minor)
  from app.posting
 group by 1, 2, 3, 4, 5, 6;

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants
-- ---------------------------------------------------------------------------------------------
create trigger budget_touch before update on app.budget for each row execute function app.touch_versioned();
create trigger budget_period_touch before update on app.budget_period for each row execute function app.touch_versioned();
create trigger budget_line_touch before update on app.budget_line for each row execute function app.touch();
create trigger goal_touch before update on app.goal for each row execute function app.touch_versioned();
create trigger expected_income_touch before update on app.expected_income for each row execute function app.touch_versioned();
create trigger recommendation_touch before update on app.recommendation for each row execute function app.touch();

-- Period, line and move edits bump the budget's version (the API does it), so one change row covers them.
create trigger budget_change after insert or update or delete on app.budget for each row execute function app.record_change();
create trigger goal_change after insert or update or delete on app.goal for each row execute function app.record_change();
create trigger expected_income_change after insert or update or delete on app.expected_income for each row execute function app.record_change();
create trigger recommendation_change after insert or update or delete on app.recommendation for each row execute function app.record_change();
create trigger budget_audit after insert or update or delete on app.budget for each row execute function app.audit_row();
create trigger budget_move_audit after insert or update or delete on app.budget_move for each row execute function app.audit_row();
create trigger goal_audit after insert or update or delete on app.goal for each row execute function app.audit_row();
create trigger expected_income_audit after insert or update or delete on app.expected_income for each row execute function app.audit_row();

do $$
declare t text;
begin
  foreach t in array array['budget', 'budget_period', 'budget_line', 'budget_move', 'goal', 'expected_income',
                           'recommendation', 'category_activity_monthly', 'account_balance_daily'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
end $$;

-- Entity-scoped planning rows: read with the entity, written by members who can write to it.
do $$
declare t text;
begin
  foreach t in array array['budget', 'goal', 'expected_income', 'recommendation'] loop
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_write', t);
  end loop;
end $$;

-- Periods follow their budget; lines and moves follow their period.
create policy budget_period_select on app.budget_period for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.budget b where b.workspace_id = budget_period.workspace_id and b.id = budget_period.budget_id));
create policy budget_period_write on app.budget_period for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.budget b where b.workspace_id = budget_period.workspace_id and b.id = budget_period.budget_id
                     and app.can_write_entity(b.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.budget b where b.workspace_id = budget_period.workspace_id and b.id = budget_period.budget_id
                     and app.can_write_entity(b.entity_id)));

do $$
declare t text;
begin
  foreach t in array array['budget_line', 'budget_move'] loop
    execute format($f$create policy %1$I on app.%2$I for select
      using (workspace_id = app.current_workspace_id()
             and exists (select 1 from app.budget_period p where p.workspace_id = %2$I.workspace_id and p.id = %2$I.budget_period_id))$f$,
      t || '_select', t);
    execute format($f$create policy %1$I on app.%2$I for all
      using (workspace_id = app.current_workspace_id()
             and exists (select 1 from app.budget_period p join app.budget b on b.workspace_id = p.workspace_id and b.id = p.budget_id
                          where p.workspace_id = %2$I.workspace_id and p.id = %2$I.budget_period_id and app.can_write_entity(b.entity_id)))
      with check (workspace_id = app.current_workspace_id()
             and exists (select 1 from app.budget_period p join app.budget b on b.workspace_id = p.workspace_id and b.id = p.budget_id
                          where p.workspace_id = %2$I.workspace_id and p.id = %2$I.budget_period_id and app.can_write_entity(b.entity_id)))$f$,
      t || '_write', t);
  end loop;
end $$;

-- Read models are written only by the posting triggers (definer); members read them like the postings.
create policy category_activity_select on app.category_activity_monthly for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id)
         and (not restricted or app.can_read_restricted(restricted_member_key)));
create policy account_balance_select on app.account_balance_daily for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id)
         and (not restricted or app.can_read_restricted(restricted_member_key)));

grant select, insert, update, delete on app.budget, app.budget_period, app.budget_line, app.budget_move, app.goal,
  app.expected_income, app.recommendation to montra_app;
grant select on app.category_activity_monthly, app.account_balance_daily to montra_app;

-- ---------------------------------------------------------------------------------------------
-- TZ-04: nightly per-workspace work runs after a local hour in each workspace's time zone. An hourly system
-- job calls this; one job per workspace and local date, created by the workspace owner (whose context it
-- runs in). Returns the number of jobs queued.
-- ---------------------------------------------------------------------------------------------
create index job_nightly on app.job (workspace_id, type, (payload ->> 'date')) where payload ? 'date';

create function app.enqueue_workspace_nightly(p_type text, p_local_hour integer) returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare n integer;
begin
  if p_type !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    raise exception 'invalid job type %', p_type;
  end if;
  insert into app.job (workspace_id, queue, type, payload, created_by)
  select w.id, 'schedule', p_type, jsonb_build_object('date', l.local_date::text), o.user_id
    from app.workspace w
   cross join lateral (select (now() at time zone w.time_zone) as local_ts,
                              (now() at time zone w.time_zone)::date as local_date) l
    join lateral (select m.user_id from app.workspace_member m
                   where m.workspace_id = w.id and m.role = 'owner' and m.status = 'active'
                   order by m.created_at, m.user_id limit 1) o on true
   where extract(hour from l.local_ts) >= p_local_hour
     and not exists (select 1 from app.job j
                      where j.workspace_id = w.id and j.type = p_type and j.payload ? 'date'
                        and j.payload ->> 'date' = l.local_date::text);
  get diagnostics n = row_count;
  return n;
end $$;

grant execute on function app.enqueue_workspace_nightly(text, integer) to montra_app;
