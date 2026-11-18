-- The household's Family Document Vault, PR 5a (ADR-0054 §5; VLT-11): reading a file's bytes through one place
-- (`FileBytes`), whoever holds them: Montra's own storage, the owner's S3/WebDAV mirror, or the vault. Nothing here
-- removes a file from Montra's storage yet; that comes with "sent with no local copy" (PR 5b).
--
-- `app.file.storage_key` loses its NOT NULL, as migration 0063 said it would (As built: PR 1): a file held only in the
-- vault has no Montra object. The check from 0063 (`file_storage_key_held`) keeps it set whenever `location = 'montra'`,
-- so no file Montra holds can lose its key. Dropping a NOT NULL takes nothing away from a task still running the old
-- code, so it needs no contract marker: no row has a null key until PR 5b removes a source, and every reader of the
-- key goes through `FileBytes` from this release.
alter table app.file alter column storage_key drop not null;

-- The objects of a workspace about to go. A file held only in the vault has no key of its own, and an object the vault's
-- job has still to remove (§5: a crash between the commit and the delete) is named only by its outbox row, which goes
-- with the connection: both are listed, so the purge leaves nothing behind.
create or replace function app.workspace_storage_keys(p_workspace uuid) returns setof text
  language sql stable security definer set search_path = app, pg_temp as $$
  select f.storage_key from app.file f
   where f.workspace_id = p_workspace and f.storage_key is not null
     and exists (select 1 from app.workspace w where w.id = p_workspace and w.purge_after < now())
  union all
  select e.storage_key from app.export_job e
   where e.workspace_id = p_workspace and e.storage_key is not null
     and exists (select 1 from app.workspace w where w.id = p_workspace and w.purge_after < now())
  union all
  select i.source_key from app.vault_item i
   where i.workspace_id = p_workspace and i.source_key is not null and i.source_removed_at is null
     and exists (select 1 from app.workspace w where w.id = p_workspace and w.purge_after < now())
$$;

-- -----------------------------------------------------------------------------
-- §5: where else a file's bytes are, for `FileBytes`. The copies (the mirror's outbox, the vault's) are for owners and
-- admins, but any reader of a file may need its bytes: a member's backup, their payslip's preview, a tax package. The
-- API first reads the file under the caller's own row-level security, and only then asks this, which answers for the
-- current workspace's members only, with where the copies are and the owner the connections act as. The bytes are then
-- read under that owner's context, as the vault's job reads them. Nothing here reaches a client.
-- -----------------------------------------------------------------------------
create function app.file_copies(p_file uuid)
  returns table (user_id uuid, mirror_id uuid, mirror_path text, vault_id uuid, vault_ref text, vault_status text,
                 content_available boolean)
  language sql stable security definer set search_path = app, pg_temp as $$
  select (select m.user_id from app.workspace_member m
           where m.workspace_id = app.current_workspace_id() and m.role = 'owner' and m.status = 'active'
           order by (m.user_id = coalesce(v.created_by, md.created_by)) desc, m.user_id limit 1),
         md.id, mi.remote_path, v.id, vi.vault_ref, vi.status, vi.content_available
    from (select 1) one
    left join app.storage_mirror_item mi
           on mi.workspace_id = app.current_workspace_id() and mi.file_id = p_file and mi.status = 'done'
              and mi.remote_path is not null
    left join app.storage_destination md
           on md.workspace_id = mi.workspace_id and md.id = mi.destination_id and md.kind in ('s3', 'webdav')
    left join app.vault_item vi on vi.workspace_id = app.current_workspace_id() and vi.file_id = p_file
    left join app.storage_destination v
           on v.workspace_id = vi.workspace_id and v.id = vi.destination_id and v.kind = 'fdv'
   where app.is_member()
$$;
revoke all on function app.file_copies(uuid) from public;
grant execute on function app.file_copies(uuid) to montra_app;
