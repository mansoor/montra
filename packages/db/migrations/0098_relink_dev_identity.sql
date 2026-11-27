-- A login made with development sign-in (`identity_id = 'dev|<email>'`) is matched by email when its person signs in
-- with real sign-in (Kratos) for the first time, so they keep their data. Until now the match was made on every
-- request and the row kept its `dev|` identity, so everything that finds a person by their Kratos identity missed
-- them: the two-step status in the members list, the "your password changed" email, and turning a login off.
--
-- `app.resolve_user(identity, email, name, email_verified)`: as the three-argument one, and when the email is verified
-- the row takes the Kratos identity in place of its `dev|` one, once. An unverified sign-in still only borrows the
-- row (it can read and not write, as before) and never moves it. Rows linked to another Kratos identity never move.
--
-- Additive: the three-argument function stays for API tasks still running the old code.

create function app.resolve_user(
  p_identity_id text,
  p_email public.citext,
  p_display_name text,
  p_email_verified boolean
) returns uuid
  language plpgsql security definer set search_path = app, pg_temp as $$
declare uid uuid;
begin
  select id into uid from app.app_user where identity_id = p_identity_id;
  if uid is not null then
    return uid;
  end if;
  insert into app.app_user (identity_id, email, display_name)
  values (p_identity_id, p_email, coalesce(p_display_name, ''))
  on conflict (email) do update set identity_id = case
      when app.app_user.identity_id is null then excluded.identity_id
      when p_email_verified
        and excluded.identity_id not like 'dev|%'
        and app.app_user.identity_id like 'dev|%' then excluded.identity_id
      else app.app_user.identity_id
    end
  returning id into uid;
  return uid;
end $$;

revoke all on function app.resolve_user(text, public.citext, text, boolean) from public;
grant execute on function app.resolve_user(text, public.citext, text, boolean) to montra_app;
