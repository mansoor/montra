-- RCP-10, BAK-09: receipts and stored files go at their retention date. The retention job (`data.retention`, hourly)
-- already removed a file past its date, but never the receipt: its lines, OCR text and extraction stayed, pointing at
-- a file that was gone. Now the receipt goes on its date, with its lines; its files fall due with it; and the job takes
-- a batch of each per run (the size is the API's setting, RETENTION_BATCH).
--
-- What stays: the transaction a receipt was matched to, and its postings. A posting split from a receipt line loses
-- only its pointer to the line (the foreign key sets it null), even in a closed or reconciled period: the amounts,
-- accounts and categories don't change, so the books are as they were.
--
-- What blocks a purge: a legal hold (ADR-0049 §4) on any active member of the workspace, and, for a file, a receipt
-- still within its date that holds it. A file another record still needs by foreign key stays, as before.
--
-- Where the bytes are (ADR-0031, ADR-0054 §10): Montra removes only its own object, and only when no other file row
-- names it. The owner's own storage and the household's vault keep their copies unless the owner asked for them to go
-- too; the existing trigger on `app.file` deletes does that, unchanged. A file held only in the vault has no object
-- here, so only its row goes.
--
-- Written so old API tasks still running during a deploy keep working: `retention_due()` keeps its shape and only
-- stops listing files, which the new functions list in batches; `purge_file` stays for those old tasks.

-- -----------------------------------------------------------------------------
-- Holds
-- -----------------------------------------------------------------------------

-- A legal hold on any active member keeps the whole workspace as it is: nothing in it ages out meanwhile.
create function app.workspace_on_legal_hold(p_workspace uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.workspace_member m
                   join app.account_suspension s on s.user_id = m.user_id and s.kind = 'legal_hold'
                  where m.workspace_id = p_workspace and m.status = 'active')
$$;
revoke all on function app.workspace_on_legal_hold(uuid) from public;

-- Whether a file has to stay although its date has passed: a legal hold, or a receipt still within its own date
-- (in the trash too, since it can still come back) that holds it.
create function app.file_retention_held(p_workspace uuid, p_file uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select app.workspace_on_legal_hold(p_workspace)
      or exists (select 1 from app.receipt r
                  where r.workspace_id = p_workspace and p_file = any (r.attachment_ids)
                    and r.retain_until >= current_date)
$$;
revoke all on function app.file_retention_held(uuid, uuid) from public;

-- -----------------------------------------------------------------------------
-- Receipts
-- -----------------------------------------------------------------------------
create index receipt_retention on app.receipt (retain_until);

-- Receipts past their date, oldest first, at most p_limit.
create function app.receipts_past_retention(p_limit integer)
  returns table (workspace_id uuid, id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select r.workspace_id, r.id from app.receipt r
   where r.retain_until < current_date and not app.workspace_on_legal_hold(r.workspace_id)
   order by r.retain_until, r.workspace_id, r.id
   limit greatest(p_limit, 0)
$$;
revoke all on function app.receipts_past_retention(integer) from public;
grant execute on function app.receipts_past_retention(integer) to montra_app;

-- Removes one receipt past its date, with its lines, OCR text and extraction. Refused (false) for one not due or held.
-- Its earlier audit entries keep who and when but lose their contents, which held the same extracted data; one entry
-- says it was purged. Its files are made due on the same date, unless another receipt holds them.
create function app.purge_receipt(p_workspace uuid, p_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare r record;
begin
  select x.retain_until, x.attachment_ids, x.transaction_id, x.deleted_at into r
    from app.receipt x
   where x.workspace_id = p_workspace and x.id = p_id and x.retain_until < current_date
     for update;
  if not found or app.workspace_on_legal_hold(p_workspace) then
    return false;
  end if;
  perform set_config('app.actor_type', 'system', true);
  -- The lines' postings only lose their pointer to the line, in a locked period too (see the top of this file).
  perform set_config('app.allow_locked_edit', 'on', true);
  delete from app.receipt where workspace_id = p_workspace and id = p_id;
  perform set_config('app.allow_locked_edit', '', true);

  update app.file f set retain_until = r.retain_until
   where f.workspace_id = p_workspace and f.id = any (r.attachment_ids)
     and (f.retain_until is null or f.retain_until > r.retain_until)
     and not exists (select 1 from app.receipt o
                      where o.workspace_id = p_workspace and f.id = any (o.attachment_ids));

  update app.audit_log set diff = jsonb_build_object('redacted', 'retention')
   where workspace_id = p_workspace and subject_type = 'receipt' and subject_id = p_id::text;
  insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
  values (p_workspace, null, 'system', 'receipt.purged', 'receipt', p_id::text,
          jsonb_build_object('reason', 'retention', 'retainUntil', r.retain_until, 'transactionId', r.transaction_id,
                             'files', cardinality(r.attachment_ids), 'wasInTrash', r.deleted_at is not null));
  return true;
end $$;
revoke all on function app.purge_receipt(uuid, uuid) from public;
grant execute on function app.purge_receipt(uuid, uuid) to montra_app;

-- -----------------------------------------------------------------------------
-- Files
-- -----------------------------------------------------------------------------

-- Files past their date, or in the trash for over 30 days, that nothing holds; oldest first, at most p_limit.
create function app.retention_files_due(p_limit integer)
  returns table (workspace_id uuid, id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select f.workspace_id, f.id from app.file f
   where (f.deleted_at < now() - interval '30 days' or f.retain_until < current_date)
     and not app.file_retention_held(f.workspace_id, f.id)
   order by coalesce(f.retain_until, f.deleted_at::date), f.workspace_id, f.id
   limit greatest(p_limit, 0)
$$;
revoke all on function app.retention_files_due(integer) from public;
grant execute on function app.retention_files_due(integer) to montra_app;

-- Removes one file's row and returns the objects in Montra's storage the caller then deletes: the file's own, and one
-- the vault's job had still to remove (ADR-0054 §5), each only when no other row of the workspace names it (a restored
-- backup copies files under keys of its own, so a key never crosses workspaces). Null when the file stays:
-- not due, held, or still needed by a record's foreign key (then, as before, its dates are cleared so it isn't looked
-- at again). An empty array for a file held only in the vault: its row goes, and the vault keeps its document.
create function app.purge_expired_file(p_workspace uuid, p_id uuid) returns text[]
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare f record; keys text[];
begin
  select x.storage_key, x.kind, x.location, x.retain_until, x.deleted_at into f
    from app.file x
   where x.workspace_id = p_workspace and x.id = p_id
     and (x.deleted_at < now() - interval '30 days' or x.retain_until < current_date)
     for update;
  if not found or app.file_retention_held(p_workspace, p_id) then
    return null;
  end if;
  select coalesce(array_agg(i.source_key), '{}') into keys from app.vault_item i
   where i.workspace_id = p_workspace and i.file_id = p_id
     and i.source_key is not null and i.source_removed_at is null;
  perform set_config('app.actor_type', 'system', true);
  begin
    delete from app.file where workspace_id = p_workspace and id = p_id;
  exception when foreign_key_violation then
    update app.file set deleted_at = null, retain_until = null where workspace_id = p_workspace and id = p_id;
    return null;
  end;
  insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
  values (p_workspace, null, 'system', 'file.purged', 'file', p_id::text,
          jsonb_build_object('reason', case when f.retain_until < current_date then 'retention' else 'trash' end,
                             'kind', f.kind, 'location', f.location, 'retainUntil', f.retain_until));
  return array(
    select distinct k from unnest(array_append(keys, f.storage_key)) as k
     where k is not null
       and not exists (select 1 from app.file o where o.workspace_id = p_workspace and o.storage_key = k)
       and not exists (select 1 from app.vault_item i
                        where i.workspace_id = p_workspace and i.source_key = k and i.source_removed_at is null));
end $$;
revoke all on function app.purge_expired_file(uuid, uuid) from public;
grant execute on function app.purge_expired_file(uuid, uuid) to montra_app;

-- What else retention has to do. Files are no longer listed here: `retention_files_due` lists them in batches.
create or replace function app.retention_due()
  returns table (kind text, workspace_id uuid, id uuid, storage_key text)
  language sql stable security definer set search_path = app, pg_temp as $$
  select 'export', e.workspace_id, e.id, e.storage_key from app.export_job e
   where e.status = 'ready' and e.expires_at < now()
  union all
  select 'restore', null::uuid, r.id, r.storage_key from app.restore_job r where r.expires_at < now()
  union all
  select 'workspace', w.id, w.id, null from app.workspace w where w.purge_after < now()
  union all
  select 'user', null::uuid, u.id, null from app.app_user u where u.purge_after < now()
$$;
