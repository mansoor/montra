-- The household's Family Document Vault, PR 3: sending (ADR-0054 §3, §4, §12, §13; VLT-02, VLT-03, VLT-04, VLT-07,
-- VLT-09). The outbox and its job (`storage.vault`) exist since migration 0063; this adds what sending found it needs.

-- -----------------------------------------------------------------------------
-- §4: a document the vault filed that Montra may not read. A vault that lets Montra send but not read tells it only
-- that the item was filed, not which document it became, so a filed row may have no document id. When Montra learns it
-- (now, or from the changes feed in PR 4) it is recorded; `out_of_reach` still needs one.
-- -----------------------------------------------------------------------------
alter table app.vault_item drop constraint vault_item_check1;
alter table app.vault_item add constraint vault_item_filed check (status <> 'filed' or filed_at is not null);

-- Whether the vault says Montra could download again the exact file it sent (vault 0.9.0-dev.60), as of its last
-- answer about the item. Null: it hasn't said. PR 5 relies on it before removing Montra's copy.
alter table app.vault_item add column content_available boolean;

-- -----------------------------------------------------------------------------
-- §3: a stored file is queued for the vault as before, and now the vault's job is woken for it. It looks a couple of
-- minutes later, by which time the upload's own record (a receipt, a payslip, an import) exists, and holds the file
-- as `queued` until Montra has finished reading it.
-- -----------------------------------------------------------------------------
create or replace function app.storage_file_added() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare queued integer;
begin
  if new.kind in ('export', 'logo') or new.sealed then return null; end if;
  insert into app.storage_mirror_item (workspace_id, destination_id, file_id)
  select d.workspace_id, d.id, new.id from app.storage_destination d
   where d.workspace_id = new.workspace_id and d.kind in ('s3', 'webdav') and d.mirror_files
     and d.status <> 'paused' and new.kind = any (d.file_kinds)
  on conflict do nothing;
  get diagnostics queued = row_count;
  if queued > 0 then
    perform app.schedule_system_job('schedule', 'storage.mirror', now());
  end if;
  insert into app.vault_item (workspace_id, destination_id, file_id)
  select d.workspace_id, d.id, new.id from app.storage_destination d
   where d.workspace_id = new.workspace_id and d.kind = 'fdv' and d.mirror_files
     and d.status <> 'paused' and new.kind = any (d.file_kinds)
  on conflict do nothing;
  get diagnostics queued = row_count;
  if queued > 0 then
    perform app.schedule_system_job('schedule', 'storage.vault', now() + interval '2 minutes');
  end if;
  return null;
end $$;
revoke all on function app.storage_file_added() from public;

-- -----------------------------------------------------------------------------
-- §3: "a file goes only when Montra is done with it". Whether anything in Montra is still reading the file, or waits
-- on a person in Review for it: a receipt or payslip being read or in review, a statement import not yet committed, a
-- scan or a statement or bill waiting to be filed, a tax form being read or checked. Definer, because a scan is its
-- uploader's own and the job runs as an owner; only for owners and admins of the current workspace.
-- -----------------------------------------------------------------------------
create function app.vault_file_busy(p_file uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select app.is_admin() and (
       exists (select 1 from app.receipt r
                where r.workspace_id = app.current_workspace_id() and p_file = any (r.attachment_ids)
                  and r.deleted_at is null and r.status in ('processing', 'needs_review'))
    or exists (select 1 from app.payslip p
                where p.workspace_id = app.current_workspace_id() and p_file = any (p.attachment_ids)
                  and p.status in ('processing', 'needs_review'))
    or exists (select 1 from app.import_batch b
                where b.workspace_id = app.current_workspace_id() and b.file_id = p_file
                  and b.status in ('uploaded', 'parsing', 'needs_mapping', 'preview', 'committing'))
    or exists (select 1 from app.document_scan s
                where s.workspace_id = app.current_workspace_id() and p_file = any (s.file_ids)
                  and s.status in ('reading', 'ready'))
    or exists (select 1 from app.document_intake n
                where n.workspace_id = app.current_workspace_id() and p_file = any (n.file_ids)
                  and n.status in ('reading', 'suggested', 'review', 'importing'))
    or exists (select 1 from app.tax_form t
                where t.workspace_id = app.current_workspace_id() and p_file = any (t.file_ids)
                  and t.deleted_at is null and t.status in ('reading', 'review')))
$$;
revoke all on function app.vault_file_busy(uuid) from public;
grant execute on function app.vault_file_busy(uuid) to montra_app;

-- -----------------------------------------------------------------------------
-- §13: the badge on a file. The outbox is for owners and admins, but anyone who can see a file sees whether it is in
-- the vault: the API asks only about files the caller can already see (row-level security on `app.file`), and this
-- answers only for the current workspace, with the status and the words, nothing else.
-- -----------------------------------------------------------------------------
create function app.vault_file_states(p_files uuid[])
  returns table (file_id uuid, status text, not_kept_reason text, vault_meta jsonb)
  language sql stable security definer set search_path = app, pg_temp as $$
  select i.file_id, i.status, i.not_kept_reason, i.vault_meta
    from app.vault_item i
   where i.workspace_id = app.current_workspace_id() and i.file_id = any (p_files[1:100])
$$;
revoke all on function app.vault_file_states(uuid[]) from public;
grant execute on function app.vault_file_states(uuid[]) to montra_app;
