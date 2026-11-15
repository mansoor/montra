-- Text messages through Twilio (ADR-0049 §6). Email stays the sign-in identifier; a phone number is an extra,
-- verified address kept in Kratos's identity traits, mirrored here so the API can text alerts and reminders.

-- -----------------------------------------------------------------------------
-- The person's number, as Kratos last reported it. Kratos owns it: this copy is refreshed on sign-in.
-- -----------------------------------------------------------------------------
alter table app.app_user add column phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$');
alter table app.app_user add column phone_verified boolean not null default false;
-- Twilio told us the number replied STOP. No reminders go to it until the number changes (ADR-0049 §6).
alter table app.app_user add column phone_opted_out_at timestamptz;

-- -----------------------------------------------------------------------------
-- What the person chose to have texted. Off until they turn it on.
-- -----------------------------------------------------------------------------
alter table app.notification_pref add column sms_security boolean not null default false;
alter table app.notification_pref add column sms_reminders boolean not null default false;

-- Refreshes the copy. Returns the number it replaced, and whether anything changed, so a change can be announced.
create function app.sync_user_phone(p_user uuid, p_phone text, p_verified boolean)
  returns table (previous text, changed boolean)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_old text;
  v_old_verified boolean;
begin
  select u.phone_e164, u.phone_verified into v_old, v_old_verified from app.app_user u where u.id = p_user for update;
  if v_old is not distinct from p_phone and v_old_verified = coalesce(p_verified, false) then
    return query select v_old, false;
    return;
  end if;
  update app.app_user
     set phone_e164 = p_phone,
         phone_verified = coalesce(p_verified, false) and p_phone is not null,
         phone_opted_out_at = case when v_old is distinct from p_phone then null else phone_opted_out_at end
   where id = p_user;
  return query select v_old, v_old is distinct from p_phone;
end $$;
revoke all on function app.sync_user_phone(uuid, text, boolean) from public;
grant execute on function app.sync_user_phone(uuid, text, boolean) to montra_app;

-- Twilio's STOP: every account on that number stops getting reminders.
create function app.note_sms_opt_out(p_phone text) returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_count integer;
begin
  update app.app_user set phone_opted_out_at = now() where phone_e164 = p_phone and phone_opted_out_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.note_sms_opt_out(text) from public;
grant execute on function app.note_sms_opt_out(text) to montra_app;

-- Where to text someone about their own account, for security alerts: only a verified number that hasn't opted out.
create function app.user_text_target(p_user uuid)
  returns table (phone text, opted_out boolean, sms_security boolean, sms_reminders boolean)
  language sql stable security definer set search_path = app, pg_temp as $$
  select u.phone_e164, u.phone_opted_out_at is not null,
         coalesce(p.sms_security, false), coalesce(p.sms_reminders, false)
    from app.app_user u left join app.notification_pref p on p.user_id = u.id
   where u.id = p_user and u.phone_verified and u.deleted_at is null
$$;
revoke all on function app.user_text_target(uuid) from public;
grant execute on function app.user_text_target(uuid) to montra_app;

-- -----------------------------------------------------------------------------
-- Reminder texts a workspace has used this month, against its plan's smsMonthly. Sign-in and security texts aren't
-- counted. The month is the calendar month in UTC, as for AI.
-- -----------------------------------------------------------------------------
create table app.sms_usage (
  workspace_id uuid not null references app.workspace (id) on delete cascade,
  month        date not null,
  sent         integer not null default 0 check (sent >= 0),
  primary key (workspace_id, month)
);
alter table app.sms_usage enable row level security;
alter table app.sms_usage force row level security;
create policy sms_usage_member on app.sms_usage for all
  using (workspace_id = app.current_workspace_id()) with check (workspace_id = app.current_workspace_id());
grant select, insert, update on app.sms_usage to montra_app;

-- Takes one text from the month's allowance if there's one left. True when it was taken.
create function app.take_sms(p_workspace uuid, p_month date, p_allowance integer) returns boolean
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  v_sent integer;
begin
  insert into app.sms_usage (workspace_id, month, sent) values (p_workspace, p_month, 0)
  on conflict (workspace_id, month) do nothing;
  update app.sms_usage set sent = sent + 1
   where workspace_id = p_workspace and month = p_month and sent < p_allowance
  returning sent into v_sent;
  return v_sent is not null;
end $$;
revoke all on function app.take_sms(uuid, date, integer) from public;
grant execute on function app.take_sms(uuid, date, integer) to montra_app;

-- A changed number is a change to the account, as a password is (ADR-0045).
alter table app.security_event drop constraint security_event_kind_check;
alter table app.security_event add constraint security_event_kind_check
  check (kind in ('sign_in_new_device', 'mfa_changed', 'password_changed', 'email_changed',
                  'session_revoked', 'export_requested', 'export_downloaded', 'backup_scheduled', 'restore_started',
                  'restore_finished', 'deletion_requested', 'deletion_cancelled', 'support_access',
                  'storage_connected', 'storage_changed', 'storage_disconnected', 'sign_in_locked',
                  'account_suspended', 'account_restored', 'deletion_requested_by_support', 'phone_changed'));

-- Leaving takes the phone number too (BAK-09). As in migration 0021, plus the number, its opt-out and any suspension
-- (migration 0053).
create or replace function app.purge_user(p_user uuid) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if not exists (select 1 from app.app_user u where u.id = p_user and u.purge_after < now()) then
    raise exception 'user % is not due for purging', p_user;
  end if;
  update app.workspace_member set status = 'revoked', invited_email = null where user_id = p_user;
  delete from app.push_device where user_id = p_user;
  delete from app.session_device where user_id = p_user;
  delete from app.notification_pref where user_id = p_user;
  delete from app.security_event where user_id = p_user;
  delete from app.restore_job where user_id = p_user;
  delete from app.support_request where user_id = p_user;
  delete from app.staff_user where user_id = p_user;
  delete from app.account_suspension where user_id = p_user;
  update app.app_user
     set email = 'deleted+' || id::text || '@invalid.example', display_name = '', identity_id = null,
         date_format = null, purge_after = null, phone_e164 = null, phone_verified = false, phone_opted_out_at = null
   where id = p_user;
end $$;

-- The hooks know a Kratos identity; texting needs the account.
create function app.user_id_for_identity(p_identity text) returns uuid
  language sql stable security definer set search_path = app, pg_temp as $$
  select u.id from app.app_user u where u.identity_id = p_identity and u.deleted_at is null
$$;
revoke all on function app.user_id_for_identity(text) from public;
grant execute on function app.user_id_for_identity(text) to montra_app;
