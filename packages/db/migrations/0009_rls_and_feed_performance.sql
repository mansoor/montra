-- 0009_rls_and_feed_performance: per-transaction caching for RLS helper functions and the change-feed
-- counter. Bulk imports post thousands of rows per transaction; both were evaluated per row.

-- Change feed: (seq, sub) — all changes of one transaction share seq.
alter table app.change_log add column sub integer not null default 0;
alter table app.change_log drop constraint change_log_pkey;
alter table app.change_log add primary key (workspace_id, seq, sub);

create or replace function app.record_change() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare r jsonb; ws uuid; next_seq bigint; next_sub integer; k text; cached text;
begin
  r := to_jsonb(coalesce(new, old));
  ws := coalesce((r ->> 'workspace_id')::uuid, case when tg_table_name = 'workspace' then (r ->> 'id')::uuid end);
  if ws is null then return null; end if;
  if tg_op = 'DELETE' and not exists (select 1 from app.workspace where id = ws) then return null; end if;
  -- One sequence value per transaction and workspace (the row lock keeps commit order), plus a sub-index per
  -- change. Updating the counter row once per transaction avoids O(n²) version chains on bulk imports.
  k := 'app.chseq_' || replace(ws::text, '-', '');
  cached := nullif(current_setting(k, true), '');
  if cached is null then
    insert into app.workspace_seq as s (workspace_id, seq) values (ws, 1)
      on conflict (workspace_id) do update set seq = s.seq + 1
      returning seq into next_seq;
    next_sub := 0;
  else
    next_seq := split_part(cached, ':', 1)::bigint;
    next_sub := split_part(cached, ':', 2)::integer + 1;
  end if;
  perform set_config(k, next_seq || ':' || next_sub, true);
  insert into app.change_log (workspace_id, seq, sub, table_name, row_id, op, entity_id, restricted)
  values (ws, next_seq, next_sub, tg_table_name,
          coalesce(r ->> 'id', r ->> 'ledger_account_id', concat_ws(':', r ->> 'transaction_id', r ->> 'tag_id', r ->> 'user_id', r ->> 'entity_id')),
          lower(tg_op),
          case when tg_table_name = 'entity' then (r ->> 'id')::uuid
               when tg_table_name = 'transaction' then (r ->> 'primary_entity_id')::uuid
               else (r ->> 'entity_id')::uuid end,
          coalesce((r ->> 'restricted')::boolean, false));
  -- Real-time push (PLT-06): delivered at commit; identical payloads in one transaction are collapsed.
  perform pg_notify('montra_changes', ws::text);
  return null;
end $$;


-- RLS helpers cache their answer for the rest of the transaction, keyed by workspace and user, so a policy
-- evaluated for every inserted row doesn't re-query membership and grants. Only a known membership is
-- cached: creating a workspace inserts the owner membership mid-transaction.
create or replace function app.current_member_role() returns text
  language plpgsql stable security definer set search_path = app, pg_temp as $$
declare ws uuid := app.current_workspace_id(); uid uuid := app.current_user_id(); tag text; cached text; r text;
begin
  if ws is null or uid is null then return null; end if;
  tag := ws::text || '|' || uid::text || '|' || coalesce(nullif(current_setting('app.cache_gen', true), ''), '0') || '|';
  cached := current_setting('app.cache_role', true);
  if cached like tag || '%' then return substr(cached, length(tag) + 1); end if;
  select role into r from app.workspace_member where workspace_id = ws and user_id = uid and status = 'active';
  if r is not null then perform set_config('app.cache_role', tag || r, true); end if;
  return r;
end $$;

create or replace function app.entity_access(p_entity uuid) returns text
  language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  ws uuid := app.current_workspace_id(); uid uuid := app.current_user_id();
  role text := app.current_member_role();
  k text := 'app.cache_ea_' || replace(p_entity::text, '-', '');
  tag text; cached text; access text;
begin
  if role is null then return 'none'; end if;
  if role = 'owner' then return 'write'; end if;
  tag := ws::text || '|' || uid::text || '|' || coalesce(nullif(current_setting('app.cache_gen', true), ''), '0') || '|';
  cached := current_setting(k, true);
  if cached like tag || '%' then return substr(cached, length(tag) + 1); end if;
  select g.access into access from app.entity_grant g where g.workspace_id = ws and g.user_id = uid and g.entity_id = p_entity;
  if access is null then
    select case when type = 'personal'
                then case role when 'partner' then 'write' when 'viewer' then 'read' else 'none' end
                else 'none' end
      into access from app.entity where id = p_entity;
  end if;
  access := coalesce(access, 'none');
  perform set_config(k, tag || access, true);
  return access;
end $$;

-- Grants and membership changes inside a transaction must not see stale cached answers.
create or replace function app.clear_access_cache() returns trigger language plpgsql as $$
begin
  perform set_config('app.cache_role', '', true);
  -- Entity entries are keyed per entity; bump a generation marker the helpers include in their tag.
  perform set_config('app.cache_gen', (coalesce(nullif(current_setting('app.cache_gen', true), ''), '0')::int + 1)::text, true);
  return null;
end $$;
create trigger workspace_member_cache after insert or update or delete on app.workspace_member
  for each statement execute function app.clear_access_cache();
create trigger entity_grant_cache after insert or update or delete on app.entity_grant
  for each statement execute function app.clear_access_cache();
