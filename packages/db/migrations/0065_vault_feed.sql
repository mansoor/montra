-- The household's Family Document Vault, PR 4: keeping in step (ADR-0054 §9, §13; VLT-05, VLT-06). The changes feed for
-- documents Montra sent, what the vault calls them, out of reach, starting over, and opening a document through a
-- single-use link made when a person clicks. The link itself is never stored: nothing here has a place for one.

-- -----------------------------------------------------------------------------
-- §9: when the job next reads the feed (a few times an hour), and a full read in progress. A full read is the first
-- one, and any read after the vault said Montra's position is no longer valid ("starting over"): once it reaches the
-- end, a filed document it didn't see is out of reach. Null `feed_next_at`: Montra may not read, so it doesn't.
-- -----------------------------------------------------------------------------
alter table app.vault_connection_state add column feed_next_at timestamptz;
alter table app.vault_connection_state add column full_read_started_at timestamptz;

-- §9: when the feed last showed this row's document. A full read that started after it, and reached the end without
-- seeing it, marks the row out of reach.
alter table app.vault_item add column feed_seen_at timestamptz;

-- -----------------------------------------------------------------------------
-- §12: a connection is also due when its feed is, while it is active or failing (not while the vault needs a person,
-- and not while paused).
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
                          and i.status in ('queued', 'pending', 'received', 'delete')
                          and i.next_attempt_at <= now())))
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
-- §9 "Opening a document": who may open a vault-held document is who may see the file in Montra. The API asks this
-- only about a file the caller can already see under row-level security on `app.file`; it answers, for the current
-- workspace's vault connection, the document to open, its status, and the owner the connection acts as (the
-- connection and its sealed key are for owners and admins, so the link is made under that owner's context, and the
-- audit row names the person who clicked). Members of the workspace only; nothing for anyone else.
-- -----------------------------------------------------------------------------
create function app.vault_file_open(p_file uuid)
  returns table (destination_id uuid, document_id text, status text, user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select i.destination_id, i.vault_document_id, i.status,
         (select m.user_id from app.workspace_member m
           where m.workspace_id = d.workspace_id and m.role = 'owner' and m.status = 'active'
           order by (m.user_id = d.created_by) desc, m.user_id limit 1)
    from app.vault_item i
    join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id and d.kind = 'fdv'
   where app.is_member() and i.workspace_id = app.current_workspace_id() and i.file_id = p_file
$$;
revoke all on function app.vault_file_open(uuid) from public;
grant execute on function app.vault_file_open(uuid) to montra_app;
