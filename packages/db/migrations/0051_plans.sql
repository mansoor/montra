-- Plans as data, and each plan's AI allowance (ADR-0049 §1, §2). Replaces the two plans that were code (ADR-0020 §1).
--
-- Which features exist is code. Which plan gets which, and how much, is data:
--   app.plan          a key, a name and whether it's offered to new customers;
--   app.plan_version  what a plan allows, as one version, never changed once someone subscribes to it;
--   app.plan_price    the provider's price id for a version and interval, with the amount for showing only.
-- app.subscription points at the version it's on.
--
-- Seeded so nothing changes: Free and Pro allow exactly what entitlementsFor() gave them, and every subscription
-- points at their first version.

create table app.plan (
  key         text primary key check (key ~ '^[a-z][a-z0-9_-]{1,31}$'),
  name        text not null check (length(name) between 1 and 60),
  description text not null default '' check (length(description) <= 500),
  -- Where it comes in the plan picker.
  sort_order  integer not null default 0,
  -- Offered to new customers. A plan that's withdrawn keeps its subscribers. Free is always offered.
  offered     boolean not null default true check (key <> 'free' or offered),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table app.plan_version (
  id           uuid primary key default gen_random_uuid(),
  plan_key     text not null references app.plan (key),
  version      integer not null check (version >= 1),
  -- PlanEntitlements in @montra/domain: businessBooks, rentalPortfolios, storageBytes, familyLogins,
  -- aiMonthlyMicroUsd, smsMonthly and features. Checked by the API against that schema on every read and write.
  entitlements jsonb not null check (jsonb_typeof(entitlements) = 'object'),
  created_by   uuid references app.app_user (id),
  created_at   timestamptz not null default now(),
  unique (plan_key, version)
);

create table app.plan_price (
  id              uuid primary key default gen_random_uuid(),
  plan_version_id uuid not null references app.plan_version (id),
  provider        text not null check (provider in ('stripe', 'apple', 'google')),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  -- The provider's own id, which is what charges. A webhook finds the version from it.
  price_ref       text not null check (length(price_ref) between 1 and 200),
  -- For showing only: the provider decides what's charged.
  amount_minor    bigint not null check (amount_minor >= 0),
  currency        char(3) not null,
  -- The price new customers get. Older prices stay, so existing subscribers are still recognised.
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (provider, price_ref)
);
create unique index plan_price_one_active on app.plan_price (plan_version_id, provider, billing_interval) where active;

-- A version someone subscribes to is what they agreed to. Changing it means a new version.
create function app.plan_version_frozen() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if (new.entitlements is distinct from old.entitlements or new.plan_key <> old.plan_key or new.version <> old.version)
     and exists (select 1 from app.subscription s where s.plan_version_id = old.id) then
    raise exception 'plan version %/% has subscribers and can''t be changed; add a new version', old.plan_key, old.version
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function app.plan_version_frozen() from public;
create trigger plan_version_frozen before update on app.plan_version
  for each row execute function app.plan_version_frozen();

insert into app.plan (key, name, description, sort_order, offered) values
  ('free', 'Free', 'Personal books, receipts and statements.', 0, true),
  ('pro', 'Pro', 'Adds business and rental books, and more storage.', 10, true);

insert into app.plan_version (plan_key, version, entitlements) values
  ('free', 1, '{"businessBooks": 0, "rentalPortfolios": 0, "storageBytes": 5368709120, "familyLogins": null,
                "aiMonthlyMicroUsd": null, "smsMonthly": 0,
                "features": ["payroll", "staffTime", "scans", "voice", "ownStorage"]}'),
  ('pro', 1, '{"businessBooks": 10, "rentalPortfolios": 10, "storageBytes": 53687091200, "familyLogins": null,
               "aiMonthlyMicroUsd": null, "smsMonthly": 0,
               "features": ["payroll", "staffTime", "scans", "voice", "ownStorage"]}');

-- -----------------------------------------------------------------------------
-- Subscriptions point at a version. `plan` stays as the plan's key, without the two-value check.
-- -----------------------------------------------------------------------------
alter table app.subscription add column plan_version_id uuid references app.plan_version (id);
alter table app.subscription drop constraint subscription_plan_check;
alter table app.subscription add constraint subscription_plan_key foreign key (plan) references app.plan (key);
update app.subscription s set plan_version_id = v.id
  from app.plan_version v where v.plan_key = s.plan and v.version = 1;
create index subscription_plan_version on app.subscription (plan_version_id);

-- -----------------------------------------------------------------------------
-- Access. The catalogue of plans is public to the app (the plan picker shows it); staff read it to show plans, and
-- change it only through admin_ functions (ADR-0049 §3).
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['plan', 'plan_version', 'plan_price'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy %I on app.%I for select to montra_app, montra_admin using (true)', t || '_read', t);
    execute format('grant select on app.%I to montra_app, montra_admin', t);
  end loop;
end $$;

-- What the workspace in context is on, whoever is asking: a job runs as the system, and still needs the plan.
create function app.current_plan()
  returns table (plan text, plan_version_id uuid, status text, trial_end timestamptz, grace_until timestamptz)
  language sql stable security definer set search_path = app, pg_temp as $$
  select s.plan, s.plan_version_id, s.status, s.trial_end, s.grace_until
    from app.subscription s where s.workspace_id = app.current_workspace_id()
$$;
revoke all on function app.current_plan() from public;
grant execute on function app.current_plan() to montra_app;

-- Writes a subscription onto a version. The plan's key and the storage quota come from the version.
create function app.apply_plan_version(
  p_workspace uuid, p_version uuid, p_status text, p_provider text, p_customer text, p_subscription text,
  p_interval text, p_trial_end timestamptz, p_period_end timestamptz, p_grace_until timestamptz,
  p_cancel_at_period_end boolean
) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_plan text;
  v_quota bigint;
begin
  select v.plan_key, (v.entitlements ->> 'storageBytes')::bigint into v_plan, v_quota
    from app.plan_version v where v.id = p_version;
  if v_plan is null then
    raise exception 'no plan version %', p_version using errcode = 'foreign_key_violation';
  end if;
  insert into app.subscription as s (workspace_id, plan, plan_version_id, status, provider, customer_ref,
                                     subscription_ref, billing_interval, trial_end, current_period_end, grace_until,
                                     cancel_at_period_end)
  values (p_workspace, v_plan, p_version, p_status, p_provider, p_customer, p_subscription, p_interval, p_trial_end,
          p_period_end, p_grace_until, p_cancel_at_period_end)
  on conflict (workspace_id) do update
    set plan = excluded.plan, plan_version_id = excluded.plan_version_id, status = excluded.status,
        provider = excluded.provider,
        customer_ref = coalesce(excluded.customer_ref, s.customer_ref),
        subscription_ref = coalesce(excluded.subscription_ref, s.subscription_ref),
        billing_interval = coalesce(excluded.billing_interval, s.billing_interval),
        trial_end = excluded.trial_end, current_period_end = excluded.current_period_end,
        -- A second failed payment doesn't start the grace again.
        grace_until = case when excluded.status = 'past_due' then coalesce(s.grace_until, excluded.grace_until)
                           else excluded.grace_until end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at = now();
  update app.workspace set storage_quota_bytes = coalesce(v_quota, storage_quota_bytes) where id = p_workspace;
end $$;
revoke all on function app.apply_plan_version(uuid, uuid, text, text, text, text, text, timestamptz, timestamptz,
  timestamptz, boolean) from public;
grant execute on function app.apply_plan_version(uuid, uuid, text, text, text, text, text, timestamptz, timestamptz,
  timestamptz, boolean) to montra_app, montra_admin;

-- -----------------------------------------------------------------------------
-- The AI allowance (ADR-0049 §2). The month is the calendar month in UTC that ai_usage already counts.
-- -----------------------------------------------------------------------------
-- What the service paid for: built-in AI only. A customer's own key or local model costs the operator nothing, so
-- it counts towards their own budget but not towards the service's ceiling.
alter table app.ai_usage add column builtin_micro_usd bigint not null default 0;
-- The highest share of the month's limit the owners have been told about: 0, 80 or 100.
alter table app.ai_usage add column alerted_pct smallint not null default 0 check (alerted_pct in (0, 80, 100));

-- The whole service's built-in AI spend this month, for the operator's ceiling. Only a total leaves.
create function app.ai_service_spend(p_month date) returns bigint
  language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce(sum(u.builtin_micro_usd), 0)::bigint from app.ai_usage u where u.month = p_month
$$;
revoke all on function app.ai_service_spend(date) from public;
grant execute on function app.ai_service_spend(date) to montra_app, montra_admin;

-- Once a month, when the ceiling is first reached: the staff to tell. Empty if they've been told this month.
create function app.ai_ceiling_reached(p_month date) returns table (email text)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  insert into app.system_setting as s (key, value) values ('ai_ceiling_alerted_month', to_char(p_month, 'YYYY-MM'))
  on conflict (key) do update set value = excluded.value, updated_at = now() where s.value <> excluded.value;
  if not found then
    return;
  end if;
  return query
    select u.email::text from app.staff_user st join app.app_user u on u.id = st.user_id
     where st.role <> 'support' and u.deleted_at is null;
end $$;
revoke all on function app.ai_ceiling_reached(date) from public;
grant execute on function app.ai_ceiling_reached(date) to montra_app;

-- 80% and 100% of the month's AI go to the workspace's owners.
alter table app.notification drop constraint notification_type_check;
alter table app.notification add constraint notification_type_check
  check (type in ('bill_due', 'low_balance', 'overspend_pace', 'large_transaction',
                  'rent_overdue', 'lease_expiring', 'import_reminder', 'monthly_review', 'tax_due', 'reminder',
                  'suggestion', 'weekly_digest', 'backup_ready', 'storage_failing', 'ai_allowance'));
