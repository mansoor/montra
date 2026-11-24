-- BAK-06, ACC-14, RCP-10: removing things from the Trash for good, now.
--
--   1. "Delete forever" (`purge_trash_item`): an owner or admin removes one Trash item now, with the same cleanup as the
--      hourly `purge_trash` 30 days after deletion: a transaction with what cascades from it; a tax form with its files
--      and their stored bytes; a personal receipt (below) with its lines, OCR text, files and bytes. Refused under a
--      legal hold, for anything dated in closed or reconciled books (DE-10), and for a receipt kept as a tax record.
--   2. Personal receipts have no minimum retention (owner's decision, 2026-11-23). A receipt is personal when its books
--      are the personal ones, none of its lines is in business or rental books, and the transaction it is matched to,
--      if any, is personal too. Its retention date is null: kept while it isn't deleted, never listed for an owner's
--      approval, and in the Trash like a transaction, gone 30 days after deletion. Business and rental receipts keep
--      their retention date and the owner-approval rule (migration 0079). The API's setting
--      `PERSONAL_RECEIPT_RETENTION_YEARS` (default 0, no minimum) can give new personal receipts a date again.
--   3. `purge_trash` no longer purges in a workspace under a legal hold, the rule migration 0079 set for retention, and
--      a transaction it can't delete (a receipt that must keep its link) stays instead of stopping the run.
--
-- Additive for old API tasks during a deploy: they still write a retention date on every receipt (only the column's
-- NOT NULL goes), and `purge_trash()` keeps its shape.

-- -----------------------------------------------------------------------------
-- Personal receipts
-- -----------------------------------------------------------------------------
alter table app.receipt alter column retain_until drop not null;

-- Whether a receipt is personal: its books, its lines' books and its matched transaction's books are all personal.
-- Invoker's rights, so the API sees only what row-level security shows it.
create function app.receipt_is_personal(p_workspace uuid, p_id uuid) returns boolean
  language sql stable set search_path = app, pg_temp as $$
  select exists (select 1 from app.receipt r join app.entity e on e.id = r.entity_id
                  where r.workspace_id = p_workspace and r.id = p_id and e.type = 'personal')
     and not exists (select 1 from app.receipt_line l join app.entity e on e.id = l.entity_id
                      where l.workspace_id = p_workspace and l.receipt_id = p_id and e.type <> 'personal')
     and not exists (select 1 from app.receipt r
                       join app.transaction t on t.workspace_id = r.workspace_id and t.id = r.transaction_id
                       join app.entity e on e.id = t.primary_entity_id
                      where r.workspace_id = p_workspace and r.id = p_id and e.type <> 'personal')
$$;
revoke all on function app.receipt_is_personal(uuid, uuid) from public;
grant execute on function app.receipt_is_personal(uuid, uuid) to montra_app;

-- Existing personal receipts lose their date, and leave the owners' approval list.
update app.receipt r set retain_until = null
 where r.retain_until is not null and app.receipt_is_personal(r.workspace_id, r.id);
delete from app.retention_item i
 where i.kind = 'receipt'
   and exists (select 1 from app.receipt r
                where r.workspace_id = i.workspace_id and r.id = i.subject_id and r.retain_until is null);

-- -----------------------------------------------------------------------------
-- Shared by the hourly job and Delete forever
-- -----------------------------------------------------------------------------

-- Whether the current workspace is under a legal hold, for the API to refuse with a reason.
create function app.current_workspace_on_legal_hold() returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select app.current_workspace_id() is not null and app.workspace_on_legal_hold(app.current_workspace_id())
$$;
revoke all on function app.current_workspace_on_legal_hold() from public;
grant execute on function app.current_workspace_on_legal_hold() to montra_app;

-- The files a removed tax form or receipt held, once no other tax form or receipt holds them. Later (p_now false, the
-- hourly job): marked deleted as of p_deleted_at, so the same retention run removes them and their bytes (migration
-- 0060). Now (p_now true, Delete forever): each row goes at once, and the storage keys come back for the caller to
-- delete, as `purge_expired_file` does; a file another record needs by foreign key is marked deleted instead.
create function app.trash_release_files(p_workspace uuid, p_files uuid[], p_deleted_at timestamptz, p_now boolean)
  returns text[]
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare f record; keys text[] := '{}'; candidates text[];
begin
  for f in select x.id, x.storage_key, x.kind, x.location from app.file x
            where x.workspace_id = p_workspace and x.id = any (p_files) and x.deleted_at is null
              and not exists (select 1 from app.tax_form o where o.workspace_id = p_workspace and x.id = any (o.file_ids))
              and not exists (select 1 from app.receipt o
                               where o.workspace_id = p_workspace and x.id = any (o.attachment_ids))
              for update loop
    if not p_now or app.file_retention_held(p_workspace, f.id) then
      update app.file set deleted_at = p_deleted_at where workspace_id = p_workspace and id = f.id;
      continue;
    end if;
    select coalesce(array_agg(i.source_key), '{}') into candidates from app.vault_item i
     where i.workspace_id = p_workspace and i.file_id = f.id
       and i.source_key is not null and i.source_removed_at is null;
    begin
      delete from app.file where workspace_id = p_workspace and id = f.id;
    exception when foreign_key_violation then
      update app.file set deleted_at = p_deleted_at where workspace_id = p_workspace and id = f.id;
      continue;
    end;
    delete from app.retention_item where workspace_id = p_workspace and kind = 'file' and subject_id = f.id;
    insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
    values (p_workspace, app.current_user_id(), 'user', 'file.purged', 'file', f.id::text,
            jsonb_build_object('reason', 'deleted_forever', 'kind', f.kind, 'location', f.location));
    keys := keys || array_append(candidates, f.storage_key);
  end loop;
  return array(
    select distinct k from unnest(keys) as k
     where k is not null
       and not exists (select 1 from app.file o where o.workspace_id = p_workspace and o.storage_key = k)
       and not exists (select 1 from app.vault_item i
                        where i.workspace_id = p_workspace and i.source_key = k and i.source_removed_at is null));
end $$;
revoke all on function app.trash_release_files(uuid, uuid[], timestamptz, boolean) from public;

-- Removes one deleted receipt with no retention date (a personal one), as `purge_receipt` removes an approved one: its
-- lines and extracted text, its earlier audit entries' contents (they held the same data), then its files. A posting
-- split from one of its lines only loses its pointer to the line. Returns the storage keys to delete (p_now), or none.
create function app.trash_purge_receipt(p_workspace uuid, p_id uuid, p_now boolean) returns text[]
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare r record; keys text[];
begin
  select x.attachment_ids, x.transaction_id, x.deleted_at into r from app.receipt x
   where x.workspace_id = p_workspace and x.id = p_id and x.deleted_at is not null and x.retain_until is null
     for update;
  if not found then
    return null;
  end if;
  perform set_config('app.allow_locked_edit', 'on', true);
  delete from app.receipt where workspace_id = p_workspace and id = p_id;
  perform set_config('app.allow_locked_edit', '', true);
  delete from app.retention_item where workspace_id = p_workspace and kind = 'receipt' and subject_id = p_id;
  update app.audit_log set diff = jsonb_build_object('redacted', 'trash')
   where workspace_id = p_workspace and subject_type = 'receipt' and subject_id = p_id::text;
  insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
  values (p_workspace, case when p_now then app.current_user_id() end, case when p_now then 'user' else 'system' end,
          'receipt.purged', 'receipt', p_id::text,
          jsonb_build_object('reason', case when p_now then 'deleted_forever' else 'trash' end,
                             'deletedAt', r.deleted_at, 'transactionId', r.transaction_id,
                             'files', cardinality(r.attachment_ids)));
  keys := app.trash_release_files(p_workspace, r.attachment_ids, r.deleted_at, p_now);
  return keys;
end $$;
revoke all on function app.trash_purge_receipt(uuid, uuid, boolean) from public;

-- -----------------------------------------------------------------------------
-- The hourly job: as in migration 0060, plus personal receipts, and nothing in a workspace under a legal hold.
-- -----------------------------------------------------------------------------
create or replace function app.purge_trash() returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare n integer := 0; r record;
begin
  perform set_config('app.actor_type', 'system', true);
  for r in select t.workspace_id, t.id from app.transaction t
            where t.deleted_at < now() - interval '30 days'
              and not exists (select 1 from app.journal_entry e
                               where e.workspace_id = t.workspace_id and e.transaction_id = t.id)
              and not app.workspace_on_legal_hold(t.workspace_id) loop
    begin
      delete from app.transaction where workspace_id = r.workspace_id and id = r.id;
      n := n + 1;
    exception when foreign_key_violation or check_violation then
      null; -- Something still refers to it (a matched receipt, say); it stays in the trash for now.
    end;
  end loop;
  for r in select t.workspace_id, t.id, t.file_ids, t.deleted_at from app.tax_form t
            where t.deleted_at < now() - interval '30 days'
              and not app.workspace_on_legal_hold(t.workspace_id) loop
    delete from app.tax_form where workspace_id = r.workspace_id and id = r.id;
    perform app.trash_release_files(r.workspace_id, r.file_ids, r.deleted_at, false);
    n := n + 1;
  end loop;
  for r in select x.workspace_id, x.id from app.receipt x
            where x.deleted_at < now() - interval '30 days' and x.retain_until is null
              and not app.workspace_on_legal_hold(x.workspace_id) loop
    perform app.trash_purge_receipt(r.workspace_id, r.id, false);
    n := n + 1;
  end loop;
  perform set_config('app.actor_type', '', true);
  return n;
end $$;

-- -----------------------------------------------------------------------------
-- Delete forever: one item of the current workspace's Trash, now.
-- -----------------------------------------------------------------------------

-- The outcome says why it stays when it does: `not_found` (not in the Trash, or not this person's to change),
-- `legal_hold`, `closed_period` (dated in closed books, or its entries were reversed or reconciled there), `receipt` (a
-- transaction with a receipt, which keeps its link while it is a tax record), `retention` (a receipt kept until its
-- retention date, then by an owner's approval) or `in_use` (another record still needs it). `deleted` returns the
-- storage keys the caller deletes. Only owners and admins; the API also asks for a recent sign-in.
create function app.purge_trash_item(p_kind text, p_id uuid)
  returns table (outcome text, storage_keys text[])
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
#variable_conflict use_column
declare v_ws uuid := app.current_workspace_id(); t record; v_found boolean := false; v_lock date; keys text[] := '{}';
begin
  if v_ws is null or coalesce(app.current_member_role(), '') not in ('owner', 'admin') then
    raise exception 'only an owner or admin can delete from the Trash for good' using errcode = 'insufficient_privilege';
  end if;

  if p_kind = 'transaction' then
    select x.primary_entity_id as entity_id, x.txn_date, x.deleted_at into t from app.transaction x
     where x.workspace_id = v_ws and x.id = p_id and x.deleted_at is not null
       and app.can_write_entity(x.primary_entity_id)
       for update;
    v_found := found;
  elsif p_kind = 'tax_form' then
    select x.entity_id, null::date as txn_date, x.deleted_at, x.file_ids, x.tax_year, x.kind into t from app.tax_form x
     where x.workspace_id = v_ws and x.id = p_id and x.deleted_at is not null
       and app.can_write_entity(x.entity_id)
       and (app.can_read_tax_form(x.person_member_id) or (x.person_member_id is null and x.created_by = app.current_user_id()))
       for update;
    v_found := found;
  elsif p_kind = 'receipt' then
    select x.entity_id, tx.txn_date, tx.primary_entity_id as txn_entity_id, x.deleted_at, x.retain_until into t
      from app.receipt x
      left join app.transaction tx on tx.workspace_id = x.workspace_id and tx.id = x.transaction_id
     where x.workspace_id = v_ws and x.id = p_id and x.deleted_at is not null
       and app.can_write_entity(x.entity_id)
       for update of x;
    v_found := found;
  end if;
  if not v_found then
    return query select 'not_found'::text, null::text[];
    return;
  end if;
  if app.workspace_on_legal_hold(v_ws) then
    return query select 'legal_hold'::text, null::text[];
    return;
  end if;

  if p_kind = 'transaction' then
    v_lock := app.locked_through(v_ws, t.entity_id);
    if (v_lock is not null and t.txn_date <= v_lock)
       or exists (select 1 from app.journal_entry e where e.workspace_id = v_ws and e.transaction_id = p_id) then
      return query select 'closed_period'::text, null::text[];
      return;
    end if;
    if exists (select 1 from app.receipt r where r.workspace_id = v_ws and r.transaction_id = p_id) then
      return query select 'receipt'::text, null::text[];
      return;
    end if;
    begin
      delete from app.transaction where workspace_id = v_ws and id = p_id;
    exception when foreign_key_violation or check_violation then
      return query select 'in_use'::text, null::text[];
      return;
    end;
    insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
    values (v_ws, app.current_user_id(), 'user', 'transaction.purged', 'transaction', p_id::text,
            jsonb_build_object('reason', 'deleted_forever', 'date', t.txn_date, 'deletedAt', t.deleted_at));
  elsif p_kind = 'tax_form' then
    delete from app.tax_form where workspace_id = v_ws and id = p_id;
    keys := app.trash_release_files(v_ws, t.file_ids, t.deleted_at, true);
    insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
    values (v_ws, app.current_user_id(), 'user', 'tax_form.purged', 'tax_form', p_id::text,
            jsonb_build_object('reason', 'deleted_forever', 'kind', t.kind, 'taxYear', t.tax_year,
                               'files', cardinality(t.file_ids), 'deletedAt', t.deleted_at));
  else
    if t.retain_until is not null then
      return query select 'retention'::text, null::text[];
      return;
    end if;
    if t.txn_date is not null then
      v_lock := app.locked_through(v_ws, t.txn_entity_id);
      if v_lock is not null and t.txn_date <= v_lock then
        return query select 'closed_period'::text, null::text[];
        return;
      end if;
    end if;
    keys := app.trash_purge_receipt(v_ws, p_id, true);
  end if;
  return query select 'deleted'::text, coalesce(keys, '{}');
end $$;
revoke all on function app.purge_trash_item(text, uuid) from public;
grant execute on function app.purge_trash_item(text, uuid) to montra_app;
