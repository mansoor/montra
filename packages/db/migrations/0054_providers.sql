-- Provider settings (ADR-0049 §5). Keys and passwords never come here: they're in the environment, or a file named in
-- <NAME>_FILE (ADR-0050). What's here is whether each provider last worked, and the settings that aren't secret.

create table app.provider_status (
  provider        text primary key
                    check (provider in ('email', 'sms', 'payments', 'errors', 'ai', 'storage', 'keys', 'push',
                                        'exchange_rates')),
  last_ok_at      timestamptz,
  last_failure_at timestamptz,
  -- Scrubbed by the API before it gets here: no addresses, URLs or long tokens.
  last_failure    text check (length(last_failure) <= 300)
);
alter table app.provider_status enable row level security;
alter table app.provider_status force row level security;

-- Written as provider calls succeed or fail, from any request or job.
create function app.note_provider(p_provider text, p_ok boolean, p_detail text) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if p_ok then
    insert into app.provider_status as s (provider, last_ok_at) values (p_provider, now())
    on conflict (provider) do update set last_ok_at = now();
  else
    insert into app.provider_status as s (provider, last_failure_at, last_failure)
    values (p_provider, now(), left(p_detail, 300))
    on conflict (provider) do update set last_failure_at = now(), last_failure = left(excluded.last_failure, 300);
  end if;
end $$;
revoke all on function app.note_provider(text, boolean, text) from public;
grant execute on function app.note_provider(text, boolean, text) to montra_app;

create function app.admin_provider_status(p_staff uuid)
  returns table (provider text, last_ok_at timestamptz, last_failure_at timestamptz, last_failure text)
  language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  perform app.require_staff_role(p_staff, 'owner');
  return query select s.provider, s.last_ok_at, s.last_failure_at, s.last_failure from app.provider_status s;
end $$;
revoke all on function app.admin_provider_status(uuid) from public;
grant execute on function app.admin_provider_status(uuid) to montra_admin;

-- What isn't secret, editable by owners: the API's sender and the support address, which kinds of text are on, and
-- the countries texts may go to. Stored in app.system_setting; an empty value means the environment's default.
create function app.admin_save_provider_settings(p_staff uuid, p_settings jsonb) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare
  k text;
begin
  perform app.require_staff_role(p_staff, 'owner');
  for k in select jsonb_object_keys(p_settings) loop
    if k not in ('mail_from_name', 'mail_from_address', 'support_email', 'sms_kinds', 'sms_countries') then
      raise exception 'not a provider setting: %', k using errcode = 'invalid_parameter_value';
    end if;
    insert into app.system_setting as s (key, value) values (k, p_settings ->> k)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end loop;
  insert into app.admin_log (staff_id, action, subject, detail) values (p_staff, 'providers.save', null, p_settings);
end $$;
revoke all on function app.admin_save_provider_settings(uuid, jsonb) from public;
grant execute on function app.admin_save_provider_settings(uuid, jsonb) to montra_admin;
