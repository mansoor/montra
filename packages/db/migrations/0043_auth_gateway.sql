-- Brute-force protection in front of Kratos (AUTH-08, ADR-0042).
--
-- The auth gateway counts failed attempts per key: a keyed hash (HMAC) of the email that was typed, of the client's
-- address, or of the session a second factor is being entered for. The database can't turn a key back into an email
-- or an address, so nothing here names a person. Rows the gateway no longer needs are pruned after a couple of hours.

create table app.auth_throttle (
  key             text primary key,
  failures        integer not null default 0 check (failures >= 0),
  window_started  timestamptz not null default now(),
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);
create index auth_throttle_updated on app.auth_throttle (updated_at);

alter table app.auth_throttle enable row level security;
alter table app.auth_throttle force row level security;
-- Only the gateway uses it, and it has no workspace or user: every row is the gateway's.
create policy auth_throttle_gateway on app.auth_throttle for all to montra_app using (true) with check (true);
grant select, insert, update, delete on app.auth_throttle to montra_app;

-- A lockout shows in the account's security activity (AUTH-12).
alter table app.security_event drop constraint security_event_kind_check;
alter table app.security_event add constraint security_event_kind_check
  check (kind in ('sign_in_new_device', 'mfa_changed', 'password_changed', 'email_changed',
                  'session_revoked', 'export_requested', 'export_downloaded', 'backup_scheduled', 'restore_started',
                  'restore_finished', 'deletion_requested', 'deletion_cancelled', 'support_access',
                  'storage_connected', 'storage_changed', 'storage_disconnected', 'sign_in_locked'));

-- Notes a lockout on the account with this email, when there is one, and says whether there was. The gateway has no
-- user context, so this runs as its owner; it reveals one bit (whether the email has an account), which the gateway
-- uses only to decide whether to send the alert email, never in a response.
create function app.note_sign_in_lockout(p_email text, p_detail jsonb) returns boolean
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  uid uuid;
begin
  -- citext's case-blind = lives in public, which is off the search path: name it.
  select id into uid from app.app_user where email operator(public.=) p_email::public.citext and deleted_at is null;
  if uid is null then
    return false;
  end if;
  insert into app.security_event (user_id, workspace_id, kind, detail) values (uid, null, 'sign_in_locked', p_detail);
  return true;
end $$;
revoke all on function app.note_sign_in_lockout(text, jsonb) from public;
grant execute on function app.note_sign_in_lockout(text, jsonb) to montra_app;
