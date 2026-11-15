-- The platform owner, staff management and the plans editor (ADR-0049 §1, §3).
--
-- Staff roles become three, each including the one below: support, admin, owner. Staff and plan changes go through
-- admin_ functions that check the caller's role with app.staff_role, so montra_admin still can't change either
-- directly, and has no grant on any financial table (ADR-0020 §6). There's always an owner.

alter table app.staff_user drop constraint staff_user_role_check;
alter table app.staff_user add constraint staff_user_role_check check (role in ('support', 'admin', 'owner'));
alter table app.staff_user add column added_by uuid references app.app_user (id) on delete set null;

-- When a version starts being the plan's current one: for new customers, and for Free, every workspace without a
-- paid plan. One that gives less than the version before it starts at least 30 days out (checked in the API).
alter table app.plan_version add column effective_from timestamptz not null default now();
create index plan_version_current on app.plan_version (plan_key, effective_from desc, version desc);

-- A move to a version that gives less: it applies from the subscriber's first renewal on or after the date.
alter table app.subscription add column pending_version_id uuid references app.plan_version (id);
alter table app.subscription add column pending_from timestamptz;
create index subscription_pending on app.subscription (pending_from) where pending_version_id is not null;

-- Each customer told about a plan change that gives them less, once. Sent by the hourly billing sweep.
create table app.plan_change_notice (
  id           uuid primary key default gen_random_uuid(),
  version_id   uuid not null references app.plan_version (id),
  workspace_id uuid not null references app.workspace (id) on delete cascade,
  apply_at     timestamptz not null,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (version_id, workspace_id)
);
create index plan_change_notice_unsent on app.plan_change_notice (created_at) where sent_at is null;
alter table app.plan_change_notice enable row level security;
alter table app.plan_change_notice force row level security;

-- -----------------------------------------------------------------------------
-- Roles. support < admin < owner.
-- -----------------------------------------------------------------------------
create function app.require_staff_role(p_staff uuid, p_role text) returns text
  language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  ranks constant text[] := array['support', 'admin', 'owner'];
  v_role text := app.staff_role(p_staff);
begin
  if v_role is null or array_position(ranks, v_role) < array_position(ranks, p_role) then
    raise exception 'this needs the % role', p_role using errcode = 'insufficient_privilege';
  end if;
  return v_role;
end $$;
revoke all on function app.require_staff_role(uuid, text) from public;

-- -----------------------------------------------------------------------------
-- Staff, managed by owners. The first owner is made with `staff:add --role owner`, which needs the database owner.
-- -----------------------------------------------------------------------------
create function app.admin_staff(p_staff uuid)
  returns table (user_id uuid, email text, display_name text, role text, created_at timestamptz, added_by_email text)
  language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_staff_role(p_staff, 'owner');
  return query
    select s.user_id, u.email::text, u.display_name, s.role, s.created_at, a.email::text
      from app.staff_user s
      join app.app_user u on u.id = s.user_id
      left join app.app_user a on a.id = s.added_by
     order by array_position(array['owner', 'admin', 'support'], s.role), u.email;
end $$;
revoke all on function app.admin_staff(uuid) from public;
grant execute on function app.admin_staff(uuid) to montra_admin;

-- Everyone who's told about a staff change.
create function app.admin_owner_emails(p_staff uuid) returns table (email text)
  language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_staff_role(p_staff, 'owner');
  return query
    select u.email::text from app.staff_user s join app.app_user u on u.id = s.user_id
     where s.role = 'owner' and u.deleted_at is null;
end $$;
revoke all on function app.admin_owner_emails(uuid) from public;
grant execute on function app.admin_owner_emails(uuid) to montra_admin;

create function app.admin_set_staff(p_staff uuid, p_email text, p_role text)
  returns table (user_id uuid, previous text)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_user uuid;
  v_old text;
begin
  perform app.require_staff_role(p_staff, 'owner');
  if p_role not in ('support', 'admin', 'owner') then
    raise exception 'no such staff role %', p_role using errcode = 'invalid_parameter_value';
  end if;
  select u.id into v_user from app.app_user u where u.email = p_email::public.citext and u.deleted_at is null;
  if v_user is null then
    raise exception 'no account for that email' using errcode = 'no_data_found';
  end if;
  -- Serialises staff changes, so two owners demoting each other can't leave none.
  perform 1 from app.staff_user where role = 'owner' for update;
  select s.role into v_old from app.staff_user s where s.user_id = v_user;
  if v_old = 'owner' and p_role <> 'owner'
     and (select count(*) from app.staff_user s where s.role = 'owner') <= 1 then
    raise exception 'there must always be an owner' using errcode = 'check_violation';
  end if;
  insert into app.staff_user as s (user_id, role, added_by) values (v_user, p_role, p_staff)
  on conflict on constraint staff_user_pkey do update set role = excluded.role;
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'staff.set', v_user::text, jsonb_build_object('email', p_email, 'role', p_role, 'from', v_old));
  return query select v_user, v_old;
end $$;
revoke all on function app.admin_set_staff(uuid, text, text) from public;
grant execute on function app.admin_set_staff(uuid, text, text) to montra_admin;

create function app.admin_remove_staff(p_staff uuid, p_user uuid) returns text
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_old text;
  v_email text;
begin
  perform app.require_staff_role(p_staff, 'owner');
  perform 1 from app.staff_user where role = 'owner' for update;
  select s.role into v_old from app.staff_user s where s.user_id = p_user;
  if v_old is null then
    return null;
  end if;
  if v_old = 'owner' and (select count(*) from app.staff_user s where s.role = 'owner') <= 1 then
    raise exception 'there must always be an owner' using errcode = 'check_violation';
  end if;
  delete from app.staff_user where user_id = p_user;
  select u.email::text into v_email from app.app_user u where u.id = p_user;
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'staff.remove', p_user::text, jsonb_build_object('email', v_email, 'from', v_old));
  return v_email;
end $$;
revoke all on function app.admin_remove_staff(uuid, uuid) from public;
grant execute on function app.admin_remove_staff(uuid, uuid) to montra_admin;

-- -----------------------------------------------------------------------------
-- Plans, edited by owners. Entitlements are checked by the API against PlanEntitlements before they get here.
-- -----------------------------------------------------------------------------
create function app.admin_save_plan(p_staff uuid, p_key text, p_name text, p_description text, p_sort integer,
                                    p_offered boolean) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  perform app.require_staff_role(p_staff, 'owner');
  insert into app.plan as p (key, name, description, sort_order, offered)
  values (p_key, p_name, p_description, p_sort, p_offered)
  on conflict (key) do update
    set name = excluded.name, description = excluded.description, sort_order = excluded.sort_order,
        offered = excluded.offered, updated_at = now();
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'plan.save', p_key,
          jsonb_build_object('name', p_name, 'sortOrder', p_sort, 'offered', p_offered));
end $$;
revoke all on function app.admin_save_plan(uuid, text, text, text, integer, boolean) from public;
grant execute on function app.admin_save_plan(uuid, text, text, text, integer, boolean) to montra_admin;

create function app.admin_add_plan_version(p_staff uuid, p_key text, p_entitlements jsonb, p_effective_from timestamptz)
  returns table (id uuid, version integer)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_version integer;
  v_id uuid;
begin
  perform app.require_staff_role(p_staff, 'owner');
  perform 1 from app.plan where key = p_key for update;
  if not found then
    raise exception 'no such plan %', p_key using errcode = 'no_data_found';
  end if;
  select coalesce(max(v.version), 0) + 1 into v_version from app.plan_version v where v.plan_key = p_key;
  insert into app.plan_version (plan_key, version, entitlements, created_by, effective_from)
  values (p_key, v_version, p_entitlements, p_staff, coalesce(p_effective_from, now()))
  returning plan_version.id into v_id;
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'plan.version', p_key,
          jsonb_build_object('version', v_version, 'entitlements', p_entitlements,
                             'effectiveFrom', coalesce(p_effective_from, now())));
  return query select v_id, v_version;
end $$;
revoke all on function app.admin_add_plan_version(uuid, text, jsonb, timestamptz) from public;
grant execute on function app.admin_add_plan_version(uuid, text, jsonb, timestamptz) to montra_admin;

-- A new price for an interval replaces the one new customers get. The old one stays, so its subscribers are known.
create function app.admin_add_plan_price(p_staff uuid, p_version uuid, p_provider text, p_interval text,
                                         p_price_ref text, p_amount bigint, p_currency text) returns uuid
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_plan text;
  v_id uuid;
begin
  perform app.require_staff_role(p_staff, 'owner');
  select v.plan_key into v_plan from app.plan_version v where v.id = p_version;
  if v_plan is null then
    raise exception 'no such plan version' using errcode = 'no_data_found';
  end if;
  if v_plan = 'free' then
    raise exception 'Free has no price' using errcode = 'check_violation';
  end if;
  update app.plan_price set active = false
   where plan_version_id = p_version and provider = p_provider and billing_interval = p_interval and active;
  insert into app.plan_price (plan_version_id, provider, billing_interval, price_ref, amount_minor, currency)
  values (p_version, p_provider, p_interval, p_price_ref, p_amount, upper(p_currency))
  returning id into v_id;
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'plan.price', v_plan,
          jsonb_build_object('version', p_version, 'provider', p_provider, 'interval', p_interval,
                             'priceRef', p_price_ref, 'amountMinor', p_amount, 'currency', upper(p_currency)));
  return v_id;
end $$;
revoke all on function app.admin_add_plan_price(uuid, uuid, text, text, text, bigint, text) from public;
grant execute on function app.admin_add_plan_price(uuid, uuid, text, text, text, bigint, text) to montra_admin;

create function app.admin_end_plan_price(p_staff uuid, p_price uuid) returns boolean
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  perform app.require_staff_role(p_staff, 'owner');
  update app.plan_price set active = false where id = p_price and active;
  if not found then
    return false;
  end if;
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'plan.price_end', p_price::text, '{}');
  return true;
end $$;
revoke all on function app.admin_end_plan_price(uuid, uuid) from public;
grant execute on function app.admin_end_plan_price(uuid, uuid) to montra_admin;

-- How many workspaces are on each version, and how many are waiting to move to it. Counts only.
create function app.admin_plan_subscribers()
  returns table (plan_version_id uuid, subscribers bigint, pending bigint)
  language sql stable security definer set search_path = app, pg_temp as $$
  select v.id,
         (select count(*) from app.subscription s where s.plan_version_id = v.id and s.status in ('trialing', 'active', 'past_due')),
         (select count(*) from app.subscription s where s.pending_version_id = v.id)
    from app.plan_version v
$$;
revoke all on function app.admin_plan_subscribers() from public;
grant execute on function app.admin_plan_subscribers() to montra_admin;

-- The first renewal on or after a date: the period end, stepped by the billing interval. Without a period, the date.
create function app.first_renewal(p_period_end timestamptz, p_interval text, p_from timestamptz) returns timestamptz
  language plpgsql immutable set search_path = app, pg_temp as $$
declare
  v timestamptz := p_period_end;
  step interval := case p_interval when 'year' then interval '1 year' else interval '1 month' end;
begin
  if v is null then
    return p_from;
  end if;
  while v < p_from loop
    v := v + step;
  end loop;
  return v;
end $$;
revoke all on function app.first_renewal(timestamptz, text, timestamptz) from public;

-- Moves a version's subscribers to another version of the same plan (ADR-0049 §1). With no date, at once: the API
-- allows that only when the new version gives at least as much. With a date, from each subscriber's first renewal
-- after it, and each is told. Returns how many moved or will.
create function app.admin_move_subscribers(p_staff uuid, p_from uuid, p_to uuid, p_after timestamptz)
  returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_from text;
  v_to text;
  v_count integer;
begin
  perform app.require_staff_role(p_staff, 'owner');
  select plan_key into v_from from app.plan_version where id = p_from;
  select plan_key into v_to from app.plan_version where id = p_to;
  if v_from is null or v_to is null or v_from <> v_to or p_from = p_to then
    raise exception 'subscribers move between two versions of one plan' using errcode = 'invalid_parameter_value';
  end if;
  if p_after is null then
    update app.subscription s set plan_version_id = p_to, pending_version_id = null, pending_from = null,
                                  updated_at = now()
     where s.plan_version_id = p_from;
    get diagnostics v_count = row_count;
    update app.workspace w set storage_quota_bytes = (v.entitlements ->> 'storageBytes')::bigint
      from app.subscription s join app.plan_version v on v.id = s.plan_version_id
     where s.workspace_id = w.id and s.plan_version_id = p_to and s.status in ('trialing', 'active', 'past_due');
  else
    update app.subscription s
       set pending_version_id = p_to,
           pending_from = app.first_renewal(s.current_period_end, s.billing_interval, p_after),
           updated_at = now()
     where s.plan_version_id = p_from;
    get diagnostics v_count = row_count;
    insert into app.plan_change_notice (version_id, workspace_id, apply_at)
    select p_to, s.workspace_id, s.pending_from from app.subscription s where s.pending_version_id = p_to
    on conflict (version_id, workspace_id) do update set apply_at = excluded.apply_at, sent_at = null;
  end if;
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'plan.move', v_from,
          jsonb_build_object('from', p_from, 'to', p_to, 'after', p_after, 'subscribers', v_count));
  return v_count;
end $$;
revoke all on function app.admin_move_subscribers(uuid, uuid, uuid, timestamptz) from public;
grant execute on function app.admin_move_subscribers(uuid, uuid, uuid, timestamptz) to montra_admin;

-- A Free version that gives less: every workspace on Free is told, as subscribers are.
create function app.admin_notify_free_change(p_staff uuid, p_version uuid) returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_from timestamptz;
  v_count integer;
begin
  perform app.require_staff_role(p_staff, 'owner');
  select effective_from into v_from from app.plan_version where id = p_version and plan_key = 'free';
  if v_from is null then
    raise exception 'not a Free version' using errcode = 'invalid_parameter_value';
  end if;
  insert into app.plan_change_notice (version_id, workspace_id, apply_at)
  select p_version, w.id, v_from from app.workspace w
   where w.deleted_at is null
     and not exists (select 1 from app.subscription s where s.workspace_id = w.id
                       and s.plan <> 'free' and s.status in ('trialing', 'active', 'past_due'))
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.admin_notify_free_change(uuid, uuid) from public;
grant execute on function app.admin_notify_free_change(uuid, uuid) to montra_admin;

-- -----------------------------------------------------------------------------
-- The worker's side: telling customers, and applying moves that have come due. Read by the hourly billing sweep.
-- -----------------------------------------------------------------------------
create function app.plan_notices_due(p_limit integer)
  returns table (id uuid, workspace_id uuid, workspace_name text, plan_name text, apply_at timestamptz, emails text[])
  language sql stable security definer set search_path = app, pg_temp as $$
  select n.id, n.workspace_id, w.name, p.name, n.apply_at,
         array(select u.email::text from app.workspace_member m join app.app_user u on u.id = m.user_id
                where m.workspace_id = n.workspace_id and m.role = 'owner' and m.status = 'active'
                  and u.deleted_at is null)
    from app.plan_change_notice n
    join app.workspace w on w.id = n.workspace_id
    join app.plan_version v on v.id = n.version_id
    join app.plan p on p.key = v.plan_key
   where n.sent_at is null
   order by n.created_at
   limit p_limit
$$;
revoke all on function app.plan_notices_due(integer) from public;
grant execute on function app.plan_notices_due(integer) to montra_app;

create function app.plan_notice_sent(p_id uuid) returns void
  language sql volatile security definer set search_path = app, pg_temp as $$
  update app.plan_change_notice set sent_at = now() where id = p_id
$$;
revoke all on function app.plan_notice_sent(uuid) from public;
grant execute on function app.plan_notice_sent(uuid) to montra_app;

create function app.apply_pending_versions() returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_count integer;
begin
  with due as (
    update app.subscription s
       set plan_version_id = s.pending_version_id, pending_version_id = null, pending_from = null, updated_at = now()
     where s.pending_version_id is not null and s.pending_from <= now()
    returning s.workspace_id, s.plan_version_id, s.status
  ), quota as (
    update app.workspace w set storage_quota_bytes = (v.entitlements ->> 'storageBytes')::bigint
      from due join app.plan_version v on v.id = due.plan_version_id
     where w.id = due.workspace_id and due.status in ('trialing', 'active', 'past_due')
    returning w.id
  )
  select count(*) into v_count from due;
  return v_count;
end $$;
revoke all on function app.apply_pending_versions() from public;
grant execute on function app.apply_pending_versions() to montra_app;

-- The webhook has no workspace in its context: which plan and version a workspace is held on.
create function app.subscription_version(p_workspace uuid) returns table (plan text, plan_version_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select s.plan, s.plan_version_id from app.subscription s where s.workspace_id = p_workspace
$$;
revoke all on function app.subscription_version(uuid) from public;
grant execute on function app.subscription_version(uuid) to montra_app;
