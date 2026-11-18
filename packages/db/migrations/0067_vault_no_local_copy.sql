-- The household's Family Document Vault, PR 5b (ADR-0054 §5, §5a; VLT-04, VLT-11, BAK-08): "sent with no local copy".
-- For a group in that mode, the vault's job removes Montra's copy of a file once the vault has filed it, the vault says
-- it could give the exact file back, the owner's own storage has its copy (when it copies that kind), and nothing in
-- Montra is reading the file. Files the vault then doesn't return are missing, and a person is asked for them again.
-- `missing_since`, `missing_reason`, `replaced_sha256`, `location` and `vault_item.source_key` exist since 0063.

-- -----------------------------------------------------------------------------
-- §5: when the job should next look at removing Montra's copy of a filed file. Null: nothing to look at. Set when a row
-- is filed, when a group is switched to "no local copy", and again (later) while a condition isn't met yet; cleared once
-- the copy is gone or the file isn't one whose copy goes.
-- -----------------------------------------------------------------------------
alter table app.vault_item add column remove_at timestamptz;
create index vault_item_remove on app.vault_item (remove_at) where remove_at is not null;

-- -----------------------------------------------------------------------------
-- §12: a connection is also due when a copy is to be looked at, or an object is still to remove after a crash between
-- the commit that moved a file and the delete (§5). Only while it is active or failing, as for its other rows.
-- -----------------------------------------------------------------------------
create or replace function app.vault_due()
  returns table (workspace_id uuid, destination_id uuid, user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select d.workspace_id, d.id,
         (select m.user_id from app.workspace_member m
           where m.workspace_id = d.workspace_id and m.role = 'owner' and m.status = 'active'
           order by (m.user_id = d.created_by) desc, m.user_id limit 1)
    from app.storage_destination d
    join app.workspace w on w.id = d.workspace_id
    left join app.vault_connection_state s on s.workspace_id = d.workspace_id and s.destination_id = d.id
   where w.deleted_at is null and d.kind = 'fdv' and d.status <> 'paused'
     and (coalesce(s.next_check_at, now()) <= now()
       or (d.status in ('active', 'failing') and s.feed_next_at <= now())
       or (d.status in ('active', 'failing')
           and exists (select 1 from app.vault_item i
                        where i.workspace_id = d.workspace_id and i.destination_id = d.id
                          and ((i.status in ('queued', 'pending', 'received', 'delete') and i.next_attempt_at <= now())
                            or i.remove_at <= now()
                            or (i.source_key is not null and i.source_removed_at is null)))))
$$;
revoke all on function app.vault_due() from public;
grant execute on function app.vault_due() to montra_app;

create or replace function app.vault_next() returns timestamptz
  language sql stable security definer set search_path = app, pg_temp as $$
  select min(t) from (
    select min(i.next_attempt_at) as t from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.status in ('queued', 'pending', 'received', 'delete') and d.status in ('active', 'failing')
    union all
    select min(i.remove_at) from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.remove_at is not null and d.status in ('active', 'failing')
    union all
    select min(now()) from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.source_key is not null and i.source_removed_at is null and d.status in ('active', 'failing')
    union all
    select min(coalesce(s.next_check_at, now())) from app.storage_destination d
      left join app.vault_connection_state s on s.workspace_id = d.workspace_id and s.destination_id = d.id
     where d.kind = 'fdv' and d.status <> 'paused'
    union all
    select min(s.feed_next_at) from app.storage_destination d
      join app.vault_connection_state s on s.workspace_id = d.workspace_id and s.destination_id = d.id
     where d.kind = 'fdv' and d.status in ('active', 'failing')
  ) x
$$;
revoke all on function app.vault_next() from public;
grant execute on function app.vault_next() to montra_app;

-- -----------------------------------------------------------------------------
-- §5.3: "no open Review item or running job". As migration 0064's definition of Montra being done with a file, and
-- also while a backup or tax package of the workspace is being made: it reads files, and would otherwise spend the
-- vault's daily reads on one whose copy went a moment before.
-- -----------------------------------------------------------------------------
create or replace function app.vault_file_busy(p_file uuid) returns boolean
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
                  and t.deleted_at is null and t.status in ('reading', 'review'))
    or exists (select 1 from app.export_job e
                where e.workspace_id = app.current_workspace_id() and e.status in ('queued', 'running')))
$$;
revoke all on function app.vault_file_busy(uuid) from public;
grant execute on function app.vault_file_busy(uuid) to montra_app;

-- -----------------------------------------------------------------------------
-- BAK-08 (ADR-0054 Consequences): a file held only in the vault takes no room in Montra's storage, so it stops counting
-- against the workspace's quota and in the storage meter. Provided again, it counts again.
-- -----------------------------------------------------------------------------
create or replace function app.check_storage_quota() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare used bigint; quota bigint;
begin
  select w.storage_quota_bytes into quota from app.workspace w where w.id = new.workspace_id;
  select coalesce(sum(f.bytes), 0) into used from app.file f
   where f.workspace_id = new.workspace_id and f.deleted_at is null and f.location = 'montra';
  if used + new.bytes > quota then
    raise exception 'storage quota reached' using errcode = 'check_violation', hint = 'storage.quota';
  end if;
  return new;
end $$;

create or replace function app.workspace_storage(p_workspace uuid)
  returns table (kind text, bytes text, quota text)
  language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce(f.kind, ''), coalesce(sum(f.bytes), 0)::text, w.storage_quota_bytes::text
    from app.workspace w
    left join app.file f on f.workspace_id = w.id and f.deleted_at is null and f.location = 'montra'
   where w.id = p_workspace and p_workspace = app.current_workspace_id()
   group by f.kind, w.storage_quota_bytes
$$;
grant execute on function app.workspace_storage(uuid) to montra_app;
