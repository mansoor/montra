-- 0008_balance_check_once: run the deferred balance check once per journal entry per transaction.
-- The constraint triggers fire per row at commit, when every change is final, so one check per entry is
-- sufficient. Bulk imports post thousands of entries; this removes two of every three identical checks.

create or replace function app.balance_check_due(p_entry uuid) returns boolean
  language plpgsql volatile as $$
declare k text := 'app.balchk_' || replace(p_entry::text, '-', '');
begin
  if current_setting(k, true) = '1' then return false; end if;
  perform set_config(k, '1', true); -- transaction-local
  return true;
end $$;

create or replace function app.check_entry_balance_from_posting() returns trigger language plpgsql as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and app.balance_check_due(new.journal_entry_id) then
    perform app.assert_entry_balanced(new.workspace_id, new.journal_entry_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or old.journal_entry_id <> new.journal_entry_id)
     and app.balance_check_due(old.journal_entry_id) then
    perform app.assert_entry_balanced(old.workspace_id, old.journal_entry_id);
  end if;
  return null;
end $$;

create or replace function app.check_entry_balance_from_entry() returns trigger language plpgsql as $$
begin
  if app.balance_check_due(new.id) then
    perform app.assert_entry_balanced(new.workspace_id, new.id);
  end if;
  return null;
end $$;

grant execute on function app.balance_check_due(uuid) to montra_app;
