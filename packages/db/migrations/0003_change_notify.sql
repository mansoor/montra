-- 0003_change_notify: notify listeners when a workspace's change feed advances (ADR-0008, PLT-06).

create or replace function app.record_change() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare r jsonb; ws uuid; next_seq bigint;
begin
  r := to_jsonb(coalesce(new, old));
  ws := coalesce((r ->> 'workspace_id')::uuid, case when tg_table_name = 'workspace' then (r ->> 'id')::uuid end);
  if ws is null then return null; end if;
  if tg_op = 'DELETE' and not exists (select 1 from app.workspace where id = ws) then return null; end if;
  insert into app.workspace_seq as s (workspace_id, seq) values (ws, 1)
    on conflict (workspace_id) do update set seq = s.seq + 1
    returning seq into next_seq;
  insert into app.change_log (workspace_id, seq, table_name, row_id, op, entity_id, restricted)
  values (ws, next_seq, tg_table_name,
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
