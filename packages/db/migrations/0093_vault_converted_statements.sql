-- VLT-12 (ADR-0057 §1, §4, §7): a statement the vault doesn't keep (a CSV, XLS or OFX export) is converted to PDF and
-- the PDF is sent through the vault's outbox in its place, when its group's "Files the vault doesn't keep" says so.
-- The choice and "Account number on the cover" are in the connection's `config` (jsonb), so they need no column.
--
--   1. The original's outbox row becomes `converted`: it is never sent itself. `render_state` says how far the
--      conversion got (rendering, rendered, not converted, import undone) and `render_options` what the PDFs were made
--      with, so a change of settings before they are sent makes them again.
--   2. Each PDF (migration 0092's renderings) gets an outbox row of its own, queued by the API in the transaction that
--      stores it. `carries_original` marks the PDF the original travels inside: §7 lets Montra remove the original only
--      once the vault has filed that one.
--   3. `app.file.superseded_at`: a PDF that "Send again" replaced with a new one. It stays in the vault, and in Montra
--      with its original (the Trash and retention), but it is no longer the original's current rendering.
--   4. `app.vault_conversion_due(file)`: an import committed or undone has the vault's job look at its file again.
--   5. `app.vault_due()` and `app.vault_next()` count converted rows that are due, as queued ones.
--   6. `app.vault_file_conversions(files)`: what the badges say about a converted file, for whoever can see it.
--
-- Additive: old API tasks never write `converted`, and read the new columns as absent.

alter table app.vault_item drop constraint vault_item_status_check;
alter table app.vault_item add constraint vault_item_status_check
  check (status in ('queued', 'pending', 'received', 'filed', 'not_kept', 'failed', 'out_of_reach', 'delete',
                    'converted'));
alter table app.vault_item
  add column render_state text check (render_state in ('rendering', 'rendered', 'not_converted', 'import_undone')),
  add column render_options jsonb,
  add column carries_original boolean not null default false,
  add constraint vault_item_converted check ((status = 'converted') = (render_state is not null));

comment on column app.vault_item.render_state is
  'ADR-0057 §1, §4: for a converted original, how far its conversion to PDF got. Null for any other row.';
comment on column app.vault_item.render_options is
  'ADR-0057 §3, §4: what the current PDFs were made with (detail, accountNumber, attachOriginal), or were asked for.';
comment on column app.vault_item.carries_original is
  'ADR-0057 §7: this row''s file is a PDF with its original attached inside it.';

alter table app.file add column superseded_at timestamptz;
alter table app.file add constraint file_superseded_rendition check (superseded_at is null or rendition is not null);
comment on column app.file.superseded_at is
  'ADR-0057 §4: a rendering replaced by a new one ("Send again"). It stays in the vault; it is no longer current.';

-- -----------------------------------------------------------------------------
-- §4: an import committed or undone changes what its file's PDF can be. Definer, because the import runs as whoever
-- made it and the outbox is for owners and admins; it only says "look again", for the current workspace's file.
-- -----------------------------------------------------------------------------
create function app.vault_conversion_due(p_file uuid) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare n integer;
begin
  if not app.is_member() then
    return;
  end if;
  update app.vault_item i set next_attempt_at = now(), updated_at = now()
   where i.workspace_id = app.current_workspace_id() and i.file_id = p_file
     and i.status in ('queued', 'converted');
  get diagnostics n = row_count;
  if n > 0 then
    perform app.schedule_system_job('schedule', 'storage.vault', now());
  end if;
end $$;
revoke all on function app.vault_conversion_due(uuid) from public;
grant execute on function app.vault_conversion_due(uuid) to montra_app;

-- -----------------------------------------------------------------------------
-- §13 for converted files: the badge on an original. As `app.vault_file_states`: anyone who can see the file sees how
-- its conversion went and how far its current PDFs got, in counts, nothing else.
-- -----------------------------------------------------------------------------
create function app.vault_file_conversions(p_files uuid[])
  returns table (file_id uuid, render_state text, attached boolean, parts integer, waiting integer, received integer,
                 filed integer, not_kept integer, failed integer, earlier integer)
  language sql stable security definer set search_path = app, pg_temp as $$
  select i.file_id, i.render_state, coalesce((i.render_options ->> 'attachOriginal')::boolean, false),
         count(r.id) filter (where r.superseded_at is null)::int,
         count(r.id) filter (where r.superseded_at is null and (ri.status is null or ri.status in ('queued', 'pending')))::int,
         count(r.id) filter (where r.superseded_at is null and ri.status = 'received')::int,
         count(r.id) filter (where r.superseded_at is null and ri.status = 'filed')::int,
         count(r.id) filter (where r.superseded_at is null and ri.status in ('not_kept', 'out_of_reach'))::int,
         count(r.id) filter (where r.superseded_at is null and ri.status = 'failed')::int,
         count(r.id) filter (where r.superseded_at is not null)::int
    from app.vault_item i
    left join app.file r
           on r.workspace_id = i.workspace_id and r.derived_from_file_id = i.file_id and r.rendition is not null
    left join app.vault_item ri
           on ri.workspace_id = r.workspace_id and ri.destination_id = i.destination_id and ri.file_id = r.id
   where app.is_member() and i.workspace_id = app.current_workspace_id() and i.status = 'converted'
     and i.file_id = any (p_files[1:100])
   group by i.file_id, i.render_state, i.render_options
$$;
revoke all on function app.vault_file_conversions(uuid[]) from public;
grant execute on function app.vault_file_conversions(uuid[]) to montra_app;

-- -----------------------------------------------------------------------------
-- §12: as 0068, and a converted row that is due (its settings changed, its import was committed or undone, or a
-- rendering is overdue) wakes the job as a queued one does.
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
