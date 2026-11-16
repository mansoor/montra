-- Confirming a mobile number through the API (ADR-0049 §6). Kratos v26.2.0 texts a code when a number is saved in a
-- settings flow but never names the verification flow it belongs to, so the code can't be entered. Instead the API
-- texts its own code, and only a confirmed number is written to the identity, already verified, through Kratos's
-- admin API. One pending request per person; the code is hashed, short-lived and single use.

create table app.phone_verification (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app.app_user (id) on delete cascade,
  phone        text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  code_hash    text not null,
  attempts     integer not null default 0 check (attempts >= 0),
  expires_at   timestamptz not null default now() + interval '10 minutes',
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at   timestamptz not null default now()
);
create index phone_verification_user on app.phone_verification (user_id, created_at desc);
create unique index phone_verification_one_open on app.phone_verification (user_id)
  where completed_at is null and cancelled_at is null;

alter table app.phone_verification enable row level security;
alter table app.phone_verification force row level security;
create policy phone_verification_own on app.phone_verification for all
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, update, delete on app.phone_verification to montra_app;

-- A number already confirmed on another account isn't texted a code: Kratos would refuse it as a second identity's
-- sign-in code address. RLS hides other people, so this is a narrow definer function, as app.email_in_use is.
create function app.phone_in_use(p_phone text) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.app_user
     where phone_e164 = p_phone and phone_verified and deleted_at is null and id <> app.current_user_id())
$$;
revoke all on function app.phone_in_use(text) from public;
grant execute on function app.phone_in_use(text) to montra_app;

-- Leaving takes any number waiting to be confirmed too (BAK-09). As in migration 0055, plus that one line.
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
  delete from app.phone_verification where user_id = p_user;
  update app.app_user
     set email = 'deleted+' || id::text || '@invalid.example', display_name = '', identity_id = null,
         date_format = null, purge_after = null, phone_e164 = null, phone_verified = false, phone_opted_out_at = null
   where id = p_user;
end $$;
