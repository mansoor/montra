-- VLT-14, VLT-15 (ADR-0059): every receipt and every bill goes to the household's vault as one PDF, one page per photo
-- (or the pages of a PDF) in the record's order, and a person can move or remove a receipt's or bill's pages afterwards.
--
--   1. `app.file.rendition` gains `record_pdf`: a PDF Montra made from a record's pages. Its pages are its sources,
--      `source_file_ids` (ordered, as the record held them when it was made). It is linked to no single original
--      (`derived_from_file_id` stays null), and is never itself rendered again.
--   2. A record's PDF is in the Trash while every page it was made from is, and comes back with any of them. When the
--      last of its pages is deleted for good, the PDF is marked deleted, so the same retention run removes it.
--   3. `app.vault_file_record(file)`: the record whose pages a file is (a receipt, a household or business bill, a
--      reimbursement, a bill scan or intake not filed yet), with its pages in order; `other` for a file another record
--      holds alone (a lease, a maintenance log, an invoice's PDF), which goes as it is; nothing for a file no record
--      holds yet (a capture still being uploaded), which waits.
--   4. `app.vault_item.pages_changed_at` and `app.vault_pages_changed(files)`: a record's pages were moved or removed. Its
--      rows still waiting are looked at again now; its rows the vault has had are marked, and the vault's job makes the
--      record's PDF again and sends it as a new document (the vault's client adds no version to a document).
--   5. `app.vault_due()` and `app.vault_next()` count marked rows as due.
--   6. `app.vault_file_conversions(files)`: a page's badge counts the record PDFs it is inside, and says it is one
--      (`combined`).
--
-- Additive: old API tasks never write `record_pdf`, `source_file_ids` or `pages_changed_at`, and read
-- `vault_file_conversions` by column name.

alter table app.file drop constraint file_rendition_check;
alter table app.file add constraint file_rendition_check check (rendition in ('statement_pdf', 'record_pdf'));
alter table app.file
  add column source_file_ids uuid[],
  -- A record's PDF has its pages, and only it has them.
  add constraint file_record_sources check (
    (source_file_ids is not null) = (rendition is not distinct from 'record_pdf')
    and (source_file_ids is null or cardinality(source_file_ids) between 1 and 100)),
  -- Made from several files, so from no one original.
  add constraint file_record_not_derived check (rendition is distinct from 'record_pdf' or derived_from_file_id is null);

create index file_sources_idx on app.file using gin (source_file_ids) where source_file_ids is not null;

comment on column app.file.source_file_ids is
  'ADR-0059: for a record PDF (rendition record_pdf), the files it was made from, in page order. Null otherwise.';

alter table app.vault_item add column pages_changed_at timestamptz;
create index vault_item_pages_changed on app.vault_item (workspace_id, destination_id, pages_changed_at)
  where pages_changed_at is not null;
comment on column app.vault_item.pages_changed_at is
  'ADR-0059: the record this file is a page of had its pages moved or removed: its PDF is made again from then.';

-- -----------------------------------------------------------------------------
-- §2: as 0092, and a record's PDF follows its pages into the Trash and back.
-- -----------------------------------------------------------------------------
create or replace function app.file_renditions_follow() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if new.deleted_at is distinct from old.deleted_at and new.rendition is null then
    update app.file r set deleted_at = new.deleted_at
     where r.workspace_id = new.workspace_id and r.derived_from_file_id = new.id
       and r.deleted_at is distinct from new.deleted_at;
    update app.file r set deleted_at = s.deleted_at
      from (select x.id, case when bool_or(p.deleted_at is null) then null else max(p.deleted_at) end as deleted_at
              from app.file x
              join app.file p on p.workspace_id = x.workspace_id and p.id = any (x.source_file_ids)
             where x.workspace_id = new.workspace_id and x.source_file_ids @> array[new.id]
               and x.rendition = 'record_pdf'
             group by x.id) s
     where r.workspace_id = new.workspace_id and r.id = s.id and r.deleted_at is distinct from s.deleted_at;
  end if;
  return null;
end $$;
revoke all on function app.file_renditions_follow() from public;

create function app.file_record_pdf_orphaned() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if old.rendition is null then
    update app.file r set deleted_at = now()
     where r.workspace_id = old.workspace_id and r.source_file_ids @> array[old.id] and r.rendition = 'record_pdf'
       and r.deleted_at is null
       and not exists (select 1 from app.file p
                        where p.workspace_id = r.workspace_id and p.id = any (r.source_file_ids)
                          and p.id <> old.id and p.deleted_at is null);
  end if;
  return null;
end $$;
revoke all on function app.file_record_pdf_orphaned() from public;
create trigger file_record_pdf_orphaned after delete on app.file
  for each row execute function app.file_record_pdf_orphaned();

-- -----------------------------------------------------------------------------
-- §3: the record a file is a page of. Definer, because the vault's job reads as an owner and some records are their
-- uploader's own (a bill scan) or payroll's (a reimbursement); it answers only for an owner or admin of the workspace.
-- -----------------------------------------------------------------------------
create function app.vault_file_record(p_file uuid)
  returns table (holder text, record_id uuid, file_ids uuid[], trashed boolean)
  language sql stable security definer set search_path = app, pg_temp as $$
  select x.holder, x.record_id, x.file_ids, x.trashed from (
    select 1 as o, 'receipt'::text as holder, r.id as record_id, r.attachment_ids as file_ids,
           r.deleted_at is not null as trashed, r.created_at
      from app.receipt r
     where r.workspace_id = app.current_workspace_id() and r.attachment_ids @> array[p_file]
    union all
    select 2, 'household_bill', h.id, h.attachment_ids, false, h.created_at from app.household_bill h
     where h.workspace_id = app.current_workspace_id() and h.attachment_ids @> array[p_file]
    union all
    select 3, 'bill', b.id, b.attachment_ids, false, b.created_at from app.bill b
     where b.workspace_id = app.current_workspace_id() and b.attachment_ids @> array[p_file]
    union all
    select 4, 'reimbursement', m.id, m.file_ids, false, m.created_at from app.reimbursement m
     where m.workspace_id = app.current_workspace_id() and m.file_ids @> array[p_file]
    union all
    select 5, 'document_intake', n.id, n.file_ids, false, n.created_at from app.document_intake n
     where n.workspace_id = app.current_workspace_id() and n.kind = 'bill' and n.status <> 'done'
       and n.file_ids @> array[p_file]
    union all
    select 6, 'document_scan', s.id, s.file_ids, false, s.created_at from app.document_scan s
     where s.workspace_id = app.current_workspace_id() and s.kind = 'bill' and s.status <> 'used'
       and s.file_ids @> array[p_file]
    union all
    select 7, 'other', null, null, false, null from app.lease l
     where l.workspace_id = app.current_workspace_id() and l.attachment_ids @> array[p_file]
    union all
    select 7, 'other', null, null, false, null from app.maintenance_log g
     where g.workspace_id = app.current_workspace_id() and g.attachment_ids @> array[p_file]
    union all
    select 7, 'other', null, null, false, null from app.invoice v
     where v.workspace_id = app.current_workspace_id() and v.pdf_file_id = p_file
  ) x
  where app.is_admin()
  order by x.o, x.trashed, x.created_at desc nulls last
  limit 1
$$;
revoke all on function app.vault_file_record(uuid) from public;
grant execute on function app.vault_file_record(uuid) to montra_app;

-- -----------------------------------------------------------------------------
-- §4: a record's pages were moved or removed. Called in the transaction that changes them, by whoever may change the
-- record; the outbox is for owners and admins, so it only says "look again", for the current workspace's files.
-- -----------------------------------------------------------------------------
create function app.vault_pages_changed(p_files uuid[]) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare waiting integer; sent integer;
begin
  if not app.is_member() then
    return;
  end if;
  update app.vault_item i set next_attempt_at = now(), updated_at = now()
   where i.workspace_id = app.current_workspace_id() and i.file_id = any (p_files[1:100])
     and i.status in ('queued', 'converted');
  get diagnostics waiting = row_count;
  update app.vault_item i set pages_changed_at = now(), updated_at = now()
   where i.workspace_id = app.current_workspace_id() and i.file_id = any (p_files[1:100])
     and i.status in ('pending', 'received', 'filed');
  get diagnostics sent = row_count;
  if waiting + sent > 0 then
    perform app.schedule_system_job('schedule', 'storage.vault', now());
  end if;
end $$;
revoke all on function app.vault_pages_changed(uuid[]) from public;
grant execute on function app.vault_pages_changed(uuid[]) to montra_app;

-- -----------------------------------------------------------------------------
-- §5: as 0093, and a row whose record's pages changed is due.
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
   where w.deleted_at is null and d.kind = 'fdv' and d.status not in ('paused', 'disconnected')
     and (coalesce(s.next_check_at, now()) <= now()
       or (d.status in ('active', 'failing') and s.feed_next_at <= now())
       or (d.status in ('active', 'failing') and s.bring_back_at <= now())
       or (d.status in ('active', 'failing')
           and exists (select 1 from app.vault_item i
                        where i.workspace_id = d.workspace_id and i.destination_id = d.id
                          and ((i.status in ('queued', 'pending', 'received', 'delete', 'converted')
                                and i.next_attempt_at <= now())
                            or i.remove_at <= now()
                            or i.pages_changed_at <= now()
                            or (i.source_key is not null and i.source_removed_at is null)))))
$$;
revoke all on function app.vault_due() from public;
grant execute on function app.vault_due() to montra_app;

create or replace function app.vault_next() returns timestamptz
  language sql stable security definer set search_path = app, pg_temp as $$
  select min(t) from (
    select min(i.next_attempt_at) as t from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.status in ('queued', 'pending', 'received', 'delete', 'converted') and d.status in ('active', 'failing')
       and i.next_attempt_at < 'infinity'
    union all
    select min(i.remove_at) from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.remove_at is not null and d.status in ('active', 'failing')
    union all
    select min(i.pages_changed_at) from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.pages_changed_at is not null and d.status in ('active', 'failing')
    union all
    select min(now()) from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.source_key is not null and i.source_removed_at is null and d.status in ('active', 'failing')
    union all
    select min(coalesce(s.next_check_at, now())) from app.storage_destination d
      left join app.vault_connection_state s on s.workspace_id = d.workspace_id and s.destination_id = d.id
     where d.kind = 'fdv' and d.status not in ('paused', 'disconnected')
    union all
    select min(s.feed_next_at) from app.storage_destination d
      join app.vault_connection_state s on s.workspace_id = d.workspace_id and s.destination_id = d.id
     where d.kind = 'fdv' and d.status in ('active', 'failing')
    union all
    select min(s.bring_back_at) from app.storage_destination d
      join app.vault_connection_state s on s.workspace_id = d.workspace_id and s.destination_id = d.id
     where d.kind = 'fdv' and d.status in ('active', 'failing')
  ) x
$$;
revoke all on function app.vault_next() from public;
grant execute on function app.vault_next() to montra_app;

-- -----------------------------------------------------------------------------
-- §6: as 0093, and a page counts the record PDFs it is inside. A new column, so the function is made again.
-- -----------------------------------------------------------------------------
drop function app.vault_file_conversions(uuid[]);
create function app.vault_file_conversions(p_files uuid[])
  returns table (file_id uuid, render_state text, attached boolean, parts integer, waiting integer, received integer,
                 filed integer, not_kept integer, failed integer, earlier integer, combined boolean)
  language sql stable security definer set search_path = app, pg_temp as $$
  select i.file_id, i.render_state, coalesce((i.render_options ->> 'attachOriginal')::boolean, false),
         count(r.id) filter (where r.superseded_at is null)::int,
         count(r.id) filter (where r.superseded_at is null and (ri.status is null or ri.status in ('queued', 'pending')))::int,
         count(r.id) filter (where r.superseded_at is null and ri.status = 'received')::int,
         count(r.id) filter (where r.superseded_at is null and ri.status = 'filed')::int,
         count(r.id) filter (where r.superseded_at is null and ri.status in ('not_kept', 'out_of_reach'))::int,
         count(r.id) filter (where r.superseded_at is null and ri.status = 'failed')::int,
         count(r.id) filter (where r.superseded_at is not null)::int,
         coalesce((i.render_options ->> 'record')::boolean, false)
    from app.vault_item i
    left join app.file r
           on r.workspace_id = i.workspace_id and r.rendition is not null
          and (r.derived_from_file_id = i.file_id or r.source_file_ids @> array[i.file_id])
    left join app.vault_item ri
           on ri.workspace_id = r.workspace_id and ri.destination_id = i.destination_id and ri.file_id = r.id
   where app.is_member() and i.workspace_id = app.current_workspace_id() and i.status = 'converted'
     and i.file_id = any (p_files[1:100])
   group by i.file_id, i.render_state, i.render_options
$$;
revoke all on function app.vault_file_conversions(uuid[]) from public;
grant execute on function app.vault_file_conversions(uuid[]) to montra_app;
