-- Faster import commits (backlog item 9). The posting guard looked up its journal entry with
-- `id = coalesce(new.journal_entry_id, old.journal_entry_id)`. PL/pgSQL plans that once per session, and with the key
-- behind coalesce the planner can't see a primary-key lookup: on a small table it chose a sequential scan, and kept
-- it while an import's transaction added entries. Every posting then scanned all the entries before it, checking
-- row-level security on each, so a commit took time in the square of its rows (1,000 rows: 16 s in this guard alone).
-- The same check, with the entry's key in plain variables; nothing else changes (0039's version otherwise).
create or replace function app.guard_posting() returns trigger language plpgsql as $$
declare
  je record;
  v_ws uuid := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  v_entry uuid := case when tg_op = 'DELETE' then old.journal_entry_id else new.journal_entry_id end;
begin
  -- Un-reconciling is the undo's alone, whatever else is allowed.
  if tg_op = 'UPDATE' and old.cleared = 'reconciled' and new.cleared <> 'reconciled' and not app.unreconcile_allowed() then
    raise exception 'a reconciled line can only be un-reconciled by undoing its reconciliation'
      using errcode = 'check_violation', hint = 'period.locked';
  end if;
  if app.locked_edit_allowed() then return coalesce(new, old); end if;
  select locked, entry_date, entity_id into je
    from app.journal_entry
   where workspace_id = v_ws and id = v_entry;
  if not found then return coalesce(new, old); end if; -- cascade from a permitted entry delete
  if je.locked or je.entry_date <= app.locked_through(old.workspace_id, je.entity_id)
     or je.entry_date <= app.locked_through(new.workspace_id, je.entity_id)
     or (tg_op <> 'INSERT' and old.cleared = 'reconciled') then
    -- Status-only changes are allowed; un-reconciling only on the undo path (checked above), outside closed periods.
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['cleared', 'reconciliation_id', 'updated_at'])
         = (to_jsonb(old) - array['cleared', 'reconciliation_id', 'updated_at'])
       and not (old.cleared = 'reconciled' and new.cleared <> 'reconciled'
                and coalesce(je.entry_date <= app.locked_through(old.workspace_id, je.entity_id), false)) then
      return new;
    end if;
    raise exception 'posting belongs to a locked or reconciled entry'
      using errcode = 'check_violation', hint = 'period.locked';
  end if;
  return coalesce(new, old);
end $$;
