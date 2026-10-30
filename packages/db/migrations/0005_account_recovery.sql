-- 0005_account_recovery: email change with dual confirmation (AUTH-11) and lost-MFA reset hold (AUTH-06).

create table app.email_change_request (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app.app_user (id) on delete cascade,
  new_email       citext not null,
  old_code_hash   text not null,
  new_code_hash   text not null,
  old_confirmed_at timestamptz,
  new_confirmed_at timestamptz,
  attempts        integer not null default 0,
  expires_at      timestamptz not null default now() + interval '24 hours',
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index email_change_request_user on app.email_change_request (user_id, created_at desc);

create table app.mfa_reset_request (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app.app_user (id) on delete cascade,
  requested_at  timestamptz not null default now(),
  eligible_at   timestamptz not null default now() + interval '72 hours',
  status        text not null default 'pending' check (status in ('pending', 'cancelled', 'completed')),
  closed_at     timestamptz
);
create unique index mfa_reset_one_pending on app.mfa_reset_request (user_id) where status = 'pending';

do $$
declare t text;
begin
  foreach t in array array['email_change_request', 'mfa_reset_request'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy %I on app.%I for all using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', t || '_own', t);
    execute format('grant select, insert, update on app.%I to montra_app', t);
  end loop;
end $$;

-- Uniqueness pre-check for email changes; RLS hides other users, so this is a narrow definer function.
create function app.email_in_use(p_email public.citext) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.app_user where email = p_email and id <> app.current_user_id())
$$;
grant execute on function app.email_in_use(public.citext) to montra_app;
