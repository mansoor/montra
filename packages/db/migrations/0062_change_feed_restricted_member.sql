-- The change feed follows the same privacy rule as RLS (PAY-09, ADR-0053 Q5).
--
-- `GET sync/changes` listed restricted (payslip) changes to owners and admins only, while `app.can_read_restricted` also
-- lets the login linked to the person read them, so a person's phone never heard about their own payslips. Each change
-- now records whose restricted row it is, and the feed asks `app.can_read_restricted` about it. The person is the
-- column RLS checks: `restricted_member_id` on journal entries and postings, `member_id` on employers and payslips.
-- Changes logged before this have no person and stay owners' and admins' only.

alter table app.change_log add column restricted_member_id uuid;

create or replace function app.record_change() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare r jsonb; ws uuid; next_seq bigint; next_sub integer; k text; cached text; is_restricted boolean;
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
  is_restricted := coalesce((r ->> 'restricted')::boolean, false);
  insert into app.change_log (workspace_id, seq, sub, table_name, row_id, op, entity_id, restricted, restricted_member_id)
  values (ws, next_seq, next_sub, tg_table_name,
          coalesce(r ->> 'id', r ->> 'ledger_account_id', concat_ws(':', r ->> 'transaction_id', r ->> 'tag_id', r ->> 'user_id', r ->> 'entity_id')),
          lower(tg_op),
          case when tg_table_name = 'entity' then (r ->> 'id')::uuid
               when tg_table_name = 'transaction' then (r ->> 'primary_entity_id')::uuid
               else (r ->> 'entity_id')::uuid end,
          is_restricted,
          case when is_restricted then
            (case when r ? 'restricted_member_id' then r ->> 'restricted_member_id' else r ->> 'member_id' end)::uuid
          end);
  -- Real-time push (PLT-06): delivered at commit; identical payloads in one transaction are collapsed.
  perform pg_notify('montra_changes', ws::text);
  return null;
end $$;
