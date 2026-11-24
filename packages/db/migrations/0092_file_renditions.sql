-- VLT-13 (ADR-0057 §2–§4): a statement the vault doesn't keep (a CSV, XLS or OFX export) can be rendered as a PDF with
-- a cover page. The PDF is a file of its own, stored once and linked to the file it came from, so everything that holds
-- for a file (the quota, the trash, sending once with the hash check) holds for it too.
--
--   1. `app.file` gains `derived_from_file_id` (the original, in the same workspace) and `rendition` (what kind of
--      rendering it is: `statement_pdf`, the only one so far). A rendered file has the original's kind, so it belongs to
--      the original's document group, and is never itself rendered again.
--   2. A rendered file goes in the Trash, and comes back out, with its original.
--   3. When the original is deleted for good, the rendering stays as a file of its own (its link is cleared): its own
--      row is purged by the same retention run, as it was trashed with the original, and its bytes with it.
--   4. A rendered file isn't queued for the household's vault when it is stored. Which renderings are sent, and how,
--      is the vault's "Files the vault doesn't keep" setting (ADR-0057 §1, VLT-12), added with sending. The owner's own
--      S3/WebDAV copy takes it like any file of its kind.
--
-- Additive: old API tasks never write these columns, and every file they store has neither.

alter table app.file
  add column derived_from_file_id uuid,
  add column rendition text check (rendition in ('statement_pdf')),
  add constraint file_derived_from foreign key (workspace_id, derived_from_file_id)
    references app.file (workspace_id, id) on delete set null (derived_from_file_id),
  -- A file made from another is a rendering. A rendering whose original was deleted for good keeps its kind alone.
  add constraint file_rendition_of check (derived_from_file_id is null or rendition is not null),
  add constraint file_not_own_rendition check (derived_from_file_id is distinct from id);

create index file_derived_from_idx on app.file (workspace_id, derived_from_file_id)
  where derived_from_file_id is not null;

comment on column app.file.derived_from_file_id is
  'ADR-0057 §4: the file this one was rendered from (same workspace). Null for an upload, or once the original is gone.';
comment on column app.file.rendition is 'ADR-0057 §4: what rendering this file is (statement_pdf), or null for an upload.';

-- -----------------------------------------------------------------------------
-- §4: a rendering is made from an original, never from another rendering, and keeps its original's kind (its group).
-- -----------------------------------------------------------------------------
create function app.file_rendition_check() returns trigger
  language plpgsql stable security definer set search_path = app, pg_temp as $$
declare o record;
begin
  if new.derived_from_file_id is null then
    return new;
  end if;
  select f.kind, f.rendition into o from app.file f
   where f.workspace_id = new.workspace_id and f.id = new.derived_from_file_id;
  if not found then
    return new; -- the foreign key says so
  end if;
  if o.rendition is not null then
    raise exception 'a rendered file is not rendered again' using errcode = 'check_violation';
  end if;
  if o.kind <> new.kind then
    raise exception 'a rendered file keeps its original''s kind' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function app.file_rendition_check() from public;
create trigger file_rendition_check before insert or update of derived_from_file_id, kind on app.file
  for each row execute function app.file_rendition_check();

-- -----------------------------------------------------------------------------
-- §4: "It goes in the Trash and follows retention with its original."
-- -----------------------------------------------------------------------------
create function app.file_renditions_follow() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if new.deleted_at is distinct from old.deleted_at and new.rendition is null then
    update app.file r set deleted_at = new.deleted_at
     where r.workspace_id = new.workspace_id and r.derived_from_file_id = new.id
       and r.deleted_at is distinct from new.deleted_at;
  end if;
  return null;
end $$;
revoke all on function app.file_renditions_follow() from public;
create trigger file_renditions_follow after update of deleted_at on app.file
  for each row execute function app.file_renditions_follow();

-- -----------------------------------------------------------------------------
-- As 0064, and a rendering isn't queued for the vault: sending them is ADR-0057 §1 (VLT-12).
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
  if new.rendition is not null then return null; end if;
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
