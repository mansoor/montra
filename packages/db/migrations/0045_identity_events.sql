-- Password and two-step changes made in Kratos (AUTH-12, ADR-0045). Kratos tells the API by a webhook that names the
-- identity, not the app user, and carries no user context, so this runs as its owner: it notes the event on the
-- account with that identity and returns the account's email for the alert, or null when there's no such account.

create function app.note_identity_event(p_identity text, p_kind text, p_detail jsonb) returns text
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  uid uuid;
  addr text;
begin
  if p_kind not in ('password_changed', 'mfa_changed') then
    raise exception 'not an identity event: %', p_kind;
  end if;
  select id, email::text into uid, addr from app.app_user where identity_id = p_identity and deleted_at is null;
  if uid is null then
    return null;
  end if;
  insert into app.security_event (user_id, workspace_id, kind, detail) values (uid, null, p_kind, p_detail);
  return addr;
end $$;
revoke all on function app.note_identity_event(text, text, jsonb) from public;
grant execute on function app.note_identity_event(text, text, jsonb) to montra_app;
