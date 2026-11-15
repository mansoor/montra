-- Managing accounts (ADR-0049 §4): suspending and restoring, extending a trial, giving a plan, and closing an account
-- on request. Staff still never see money: these functions return people, plans and dates.

-- -----------------------------------------------------------------------------
-- Suspension: for abuse, fraud or a legal hold, never for a missed payment (that's a lapse, ADR-0020 §3).
-- -----------------------------------------------------------------------------
create table app.account_suspension (
  user_id      uuid primary key references app.app_user (id) on delete cascade,
  kind         text not null check (kind in ('abuse', 'fraud', 'legal_hold')),
  reason       text not null check (length(reason) between 3 and 500),
  suspended_by uuid not null references app.app_user (id),
  suspended_at timestamptz not null default now()
);
alter table app.account_suspension enable row level security;
alter table app.account_suspension force row level security;

-- Whether a person is suspended, for the auth guard. Only a yes or no leaves.
create function app.user_suspended(p_user uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.account_suspension s where s.user_id = p_user)
$$;
revoke all on function app.user_suspended(uuid) from public;
grant execute on function app.user_suspended(uuid) to montra_app;

-- A workspace an active owner of which is suspended is closed to every member. The data is kept.
create function app.workspace_suspended(p_workspace uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.workspace_member m join app.account_suspension s on s.user_id = m.user_id
     where m.workspace_id = p_workspace and m.role = 'owner' and m.status = 'active')
$$;
revoke all on function app.workspace_suspended(uuid) from public;
grant execute on function app.workspace_suspended(uuid) to montra_app;

-- Returns the person's sign-in identity, for revoking sessions, and email, for telling them.
create function app.admin_suspend(p_staff uuid, p_user uuid, p_kind text, p_reason text)
  returns table (identity_id text, email text)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  perform app.require_staff_role(p_staff, 'admin');
  if p_user = p_staff then
    raise exception 'staff can''t suspend themselves' using errcode = 'invalid_parameter_value';
  end if;
  insert into app.account_suspension (user_id, kind, reason, suspended_by) values (p_user, p_kind, p_reason, p_staff)
  on conflict (user_id) do update set kind = excluded.kind, reason = excluded.reason,
                                      suspended_by = excluded.suspended_by, suspended_at = now();
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'account.suspend', p_user::text, jsonb_build_object('kind', p_kind, 'reason', p_reason));
  insert into app.security_event (user_id, workspace_id, kind, detail)
  values (p_user, null, 'account_suspended', jsonb_build_object('kind', p_kind));
  return query select u.identity_id::text, u.email::text from app.app_user u where u.id = p_user;
end $$;
revoke all on function app.admin_suspend(uuid, uuid, text, text) from public;
grant execute on function app.admin_suspend(uuid, uuid, text, text) to montra_admin;

create function app.admin_restore(p_staff uuid, p_user uuid)
  returns table (identity_id text, email text, kind text)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_kind text;
begin
  perform app.require_staff_role(p_staff, 'admin');
  delete from app.account_suspension s where s.user_id = p_user returning s.kind into v_kind;
  if v_kind is null then
    return;
  end if;
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'account.restore', p_user::text, jsonb_build_object('kind', v_kind));
  insert into app.security_event (user_id, workspace_id, kind, detail)
  values (p_user, null, 'account_restored', '{}');
  return query select u.identity_id::text, u.email::text, v_kind from app.app_user u where u.id = p_user;
end $$;
revoke all on function app.admin_restore(uuid, uuid) from public;
grant execute on function app.admin_restore(uuid, uuid) to montra_admin;

-- What the console shows about people: whether they're suspended, and why.
create function app.admin_account_states(p_users uuid[])
  returns table (user_id uuid, kind text, reason text, suspended_at timestamptz, purge_after timestamptz)
  language sql stable security definer set search_path = app, pg_temp as $$
  select u.id, s.kind, s.reason, s.suspended_at, u.purge_after
    from app.app_user u left join app.account_suspension s on s.user_id = u.id
   where u.id = any (p_users)
$$;
revoke all on function app.admin_account_states(uuid[]) from public;
grant execute on function app.admin_account_states(uuid[]) to montra_admin;

alter table app.security_event drop constraint security_event_kind_check;
alter table app.security_event add constraint security_event_kind_check
  check (kind in ('sign_in_new_device', 'mfa_changed', 'password_changed', 'email_changed',
                  'session_revoked', 'export_requested', 'export_downloaded', 'backup_scheduled', 'restore_started',
                  'restore_finished', 'deletion_requested', 'deletion_cancelled', 'support_access',
                  'storage_connected', 'storage_changed', 'storage_disconnected', 'sign_in_locked',
                  'account_suspended', 'account_restored', 'deletion_requested_by_support'));

-- -----------------------------------------------------------------------------
-- Given plans (provider comp): a version and an end date, never through Stripe.
-- -----------------------------------------------------------------------------
alter table app.subscription drop constraint subscription_provider_check;
alter table app.subscription add constraint subscription_provider_check
  check (provider in ('stripe', 'apple', 'google', 'staff', 'comp'));

-- A given plan ends on its date, as a trial does.
create or replace function app.subscriptions_lapsed() returns table (workspace_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select s.workspace_id from app.subscription s
   where s.plan <> 'free'
     and ((s.status = 'past_due' and s.grace_until < now())
       or (s.status = 'trialing' and s.trial_end < now())
       or (s.provider = 'comp' and s.status = 'active' and s.current_period_end < now()))
$$;

-- current_plan() gains the provider and period end, so a given plan stops counting on its date.
drop function app.current_plan();
create function app.current_plan()
  returns table (plan text, plan_version_id uuid, status text, trial_end timestamptz, grace_until timestamptz,
                 provider text, current_period_end timestamptz)
  language sql stable security definer set search_path = app, pg_temp as $$
  select s.plan, s.plan_version_id, s.status, s.trial_end, s.grace_until, s.provider, s.current_period_end
    from app.subscription s where s.workspace_id = app.current_workspace_id()
$$;
revoke all on function app.current_plan() from public;
grant execute on function app.current_plan() to montra_app;

-- The console's workspace rows gain the trial's end and the plan's name.
create function app.admin_workspace_plans(p_workspaces uuid[])
  returns table (workspace_id uuid, plan_name text, trial_end timestamptz, subscription_ref text)
  language sql stable security definer set search_path = app, pg_temp as $$
  select w.id, coalesce(p.name, 'Free'), s.trial_end, s.subscription_ref
    from app.workspace w
    left join app.subscription s on s.workspace_id = w.id
    left join app.plan p on p.key = s.plan
   where w.id = any (p_workspaces)
$$;
revoke all on function app.admin_workspace_plans(uuid[]) from public;
grant execute on function app.admin_workspace_plans(uuid[]) to montra_admin;

-- A trial runs on, up to 30 days at a time. Stripe is told first, by the API.
create function app.admin_extend_trial(p_staff uuid, p_workspace uuid, p_trial_end timestamptz, p_reason text)
  returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_old timestamptz;
begin
  perform app.require_staff_role(p_staff, 'admin');
  select trial_end into v_old from app.subscription where workspace_id = p_workspace and status = 'trialing' for update;
  if v_old is null then
    raise exception 'that workspace isn''t on a trial' using errcode = 'invalid_parameter_value';
  end if;
  if p_trial_end <= v_old or p_trial_end > greatest(v_old, now()) + interval '30 days 1 minute' then
    raise exception 'a trial is extended by up to 30 days at a time' using errcode = 'invalid_parameter_value';
  end if;
  update app.subscription set trial_end = p_trial_end, updated_at = now() where workspace_id = p_workspace;
  insert into app.admin_log (staff_id, action, subject, detail)
  values (p_staff, 'trial.extend', p_workspace::text,
          jsonb_build_object('from', v_old, 'to', p_trial_end, 'reason', p_reason));
end $$;
revoke all on function app.admin_extend_trial(uuid, uuid, timestamptz, text) from public;
grant execute on function app.admin_extend_trial(uuid, uuid, timestamptz, text) to montra_admin;
