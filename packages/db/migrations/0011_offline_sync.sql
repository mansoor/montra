-- Phase 4: offline sync (PLT-05, ADR-0013) and push-notification devices.

-- ---------------------------------------------------------------------------------------------
-- Field-group clocks: { group: { v: row version, at: timestamptz } } for field-group LWW.
-- Groups: ledger (spec without description), payee (payee_raw, description), date, memo, tags, review.
-- ---------------------------------------------------------------------------------------------
alter table app.transaction add column field_clock jsonb not null default '{}';

create function app.transaction_field_clock() returns trigger language plpgsql as $$
declare
  v_entry jsonb := jsonb_build_object('v', new.version, 'at', now());
begin
  if (old.spec - 'description') is distinct from (new.spec - 'description') then
    new.field_clock := jsonb_set(new.field_clock, '{ledger}', v_entry);
  end if;
  if old.payee_raw is distinct from new.payee_raw or old.description is distinct from new.description then
    new.field_clock := jsonb_set(new.field_clock, '{payee}', v_entry);
  end if;
  if old.txn_date is distinct from new.txn_date then
    new.field_clock := jsonb_set(new.field_clock, '{date}', v_entry);
  end if;
  if old.memo_enc is distinct from new.memo_enc then
    new.field_clock := jsonb_set(new.field_clock, '{memo}', v_entry);
  end if;
  if old.review_state is distinct from new.review_state then
    new.field_clock := jsonb_set(new.field_clock, '{review}', v_entry);
  end if;
  return new;
end $$;

-- Runs after transaction_touch (triggers fire in name order), so new.version is already bumped.
create trigger transaction_zz_field_clock before update on app.transaction
  for each row execute function app.transaction_field_clock();

-- The clocks are sync bookkeeping, not user data: keep them out of the audit trail (NFR-03).
create or replace function app.audit_row() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare o jsonb; n jsonb; d jsonb; k text;
begin
  o := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  if tg_op = 'UPDATE' then
    d := '{}';
    for k in select jsonb_object_keys(n) loop
      if k not in ('updated_at', 'version', 'field_clock') and (o -> k) is distinct from (n -> k) then
        d := d || jsonb_build_object(k, case when k like '%\_enc' then '"[redacted]"'::jsonb
                                             else jsonb_build_array(o -> k, n -> k) end);
      end if;
    end loop;
    if d = '{}' then return null; end if;
  else
    d := coalesce(n, o) - 'field_clock';
    for k in select jsonb_object_keys(d) loop
      if k like '%\_enc' then d := d || jsonb_build_object(k, '[redacted]'::text); end if;
    end loop;
  end if;
  insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
  values (coalesce((coalesce(n, o) ->> 'workspace_id')::uuid, (coalesce(n, o) ->> 'id')::uuid),
          app.current_user_id(),
          coalesce(nullif(current_setting('app.actor_type', true), ''), 'user'),
          tg_table_name || '.' || lower(tg_op), tg_table_name,
          coalesce(coalesce(n, o) ->> 'id', coalesce(n, o) ->> 'ledger_account_id', coalesce(n, o) ->> 'entity_id'),
          d);
  return null;
end $$;

-- Tags live in their own table: a change bumps the transaction (version and the tags clock).
create function app.transaction_tag_clock() returns trigger language plpgsql as $$
declare
  v_ws uuid := coalesce(new.workspace_id, old.workspace_id);
  v_id uuid := coalesce(new.transaction_id, old.transaction_id);
begin
  update app.transaction
     set field_clock = jsonb_set(field_clock, '{tags}', jsonb_build_object('v', version + 1, 'at', now()))
   where workspace_id = v_ws and id = v_id;
  return null;
end $$;

create trigger transaction_tag_clock after insert or delete on app.transaction_tag
  for each row execute function app.transaction_tag_clock();

-- ---------------------------------------------------------------------------------------------
-- Replayed outbox ops: the first result of each opId, returned again on replay. Purged after 30 days.
-- ---------------------------------------------------------------------------------------------
create table app.sync_op (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  op_id         uuid not null,
  user_id       uuid not null references app.app_user (id) on delete cascade,
  kind          text not null,
  result        jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, op_id)
);
create index sync_op_age on app.sync_op (created_at);

-- ---------------------------------------------------------------------------------------------
-- Push-notification devices (per user, not per workspace)
-- ---------------------------------------------------------------------------------------------
create table app.push_device (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app.app_user (id) on delete cascade,
  token         text not null unique,
  platform      text not null check (platform in ('ios', 'android')),
  device_name   text,
  app_version   text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index push_device_user on app.push_device (user_id);

alter table app.sync_op enable row level security;
alter table app.sync_op force row level security;
create policy sync_op_own on app.sync_op for all
  using (workspace_id = app.current_workspace_id() and user_id = app.current_user_id())
  with check (workspace_id = app.current_workspace_id() and user_id = app.current_user_id());

alter table app.push_device enable row level security;
alter table app.push_device force row level security;
create policy push_device_own on app.push_device for all
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- A token moves to whoever signs in on the device last; RLS would hide the other user's row, so the
-- upsert runs as definer and only ever assigns the token to the caller.
create function app.register_push_device(p_token text, p_platform text, p_name text, p_version text)
returns uuid language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id uuid;
begin
  if app.current_user_id() is null then raise exception 'no user' using errcode = '42501'; end if;
  insert into app.push_device (user_id, token, platform, device_name, app_version)
  values (app.current_user_id(), p_token, p_platform, p_name, p_version)
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, device_name = excluded.device_name,
        app_version = excluded.app_version, last_seen_at = now()
  returning id into v_id;
  return v_id;
end $$;

grant select, insert, update, delete on app.sync_op, app.push_device to montra_app;
grant execute on function app.register_push_device(text, text, text, text) to montra_app;
