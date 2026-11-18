-- The household's Family Document Vault, PR 5b2 (ADR-0054 §5a, §10, §12; VLT-04, VLT-11, BAK-04, BAK-06): moving files
-- the vault filed before their group went "no local copy", bringing files back, disconnecting while files are only in
-- the vault, and what an archive says about files it couldn't include.

-- -----------------------------------------------------------------------------
-- §10: a soft disconnect. A connection the owner disconnects while files are held only in the vault stays, `disconnected`,
-- with its outbox: those rows are how Montra reads the files back if the owner connects the same vault again. Nothing is
-- sent, its key is wiped (`secret_enc` null), and the files it held become missing. Only a disconnected connection has
-- no key.
-- -----------------------------------------------------------------------------
alter table app.storage_destination drop constraint storage_destination_status_check;
alter table app.storage_destination add constraint storage_destination_status_check
  check (status in ('active', 'paused', 'failing', 'needs_vault', 'disconnected'));
alter table app.storage_destination add constraint storage_destination_disconnected
  check (status <> 'disconnected' or kind = 'fdv');
-- Dropping a NOT NULL takes nothing from code still running: no row has a null secret until this release disconnects one.
alter table app.storage_destination alter column secret_enc drop not null;
alter table app.storage_destination add constraint storage_destination_secret_held
  check (secret_enc is not null or status = 'disconnected');

-- -----------------------------------------------------------------------------
-- §10 "Bring the files back": the job copies every file held only in the vault back into Montra's storage, one at a
-- time, over days when the vault's daily read cap needs it. `bring_back_at` is when it next looks (null: not bringing
-- any back); `bring_back_then` says whether the connection is disconnected once they are back; `bring_back_by` is the
-- owner who asked, for the security log.
-- -----------------------------------------------------------------------------
alter table app.vault_connection_state add column bring_back_at timestamptz;
alter table app.vault_connection_state add column bring_back_then text
  check (bring_back_then in ('keep', 'disconnect'));
alter table app.vault_connection_state add column bring_back_by uuid;
alter table app.vault_connection_state add constraint vault_connection_state_bring_back
  check ((bring_back_at is null) = (bring_back_then is null));

-- -----------------------------------------------------------------------------
-- §12: a connection is also due when files are being brought back. A disconnected one never is: it has no key.
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
-- §5a: what an archive's screen says. `missing_files` counts the files a backup or tax package couldn't include (its
-- README lists them); `waiting_until` is set while a background archive waits once for the vault's daily read cap to
-- reset before it is made.
-- -----------------------------------------------------------------------------
alter table app.export_job add column missing_files integer not null default 0 check (missing_files >= 0);
alter table app.export_job add column waiting_until timestamptz;

-- -----------------------------------------------------------------------------
-- §9, §10: the badges offer "Open in the vault" to anyone who can see a file, but the connection is for owners and
-- admins. Whether the workspace's vault connection is disconnected, for its members: nothing opens there then.
-- -----------------------------------------------------------------------------
create function app.vault_disconnected() returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select app.is_member() and exists (
    select 1 from app.storage_destination d
     where d.workspace_id = app.current_workspace_id() and d.kind = 'fdv' and d.status = 'disconnected')
$$;
revoke all on function app.vault_disconnected() from public;
grant execute on function app.vault_disconnected() to montra_app;
