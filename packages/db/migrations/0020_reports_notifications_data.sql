-- Phase 10: reports, search, notifications and data ownership (RPT-01..06, NOT-01..03, AUTH-12, BAK-04..09; ADR-0019).

-- -----------------------------------------------------------------------------
-- RPT-02: saved reports. Each user's own.
-- -----------------------------------------------------------------------------
create table app.saved_report (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  user_id       uuid not null references app.app_user (id),
  name          text not null check (length(name) between 1 and 200),
  type          text not null,
  filters       jsonb not null default '{}',
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, user_id, name)
);

-- -----------------------------------------------------------------------------
-- RPT-05: search over payee and description. Notes are encrypted and matched in the API (ADR-0019 §3).
-- -----------------------------------------------------------------------------
alter table app.transaction add column search tsvector generated always as
  (to_tsvector('simple', coalesce(payee_raw, '') || ' ' || coalesce(description, ''))) stored;
create index transaction_search on app.transaction using gin (search);

-- -----------------------------------------------------------------------------
-- NOT-01..03: notifications, per user. Preferences follow the user across workspaces.
-- -----------------------------------------------------------------------------
create table app.notification (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  user_id       uuid not null references app.app_user (id),
  type          text not null check (type in ('bill_due', 'low_balance', 'overspend_pace', 'large_transaction',
                  'rent_overdue', 'lease_expiring', 'import_reminder', 'monthly_review', 'tax_due', 'reminder',
                  'suggestion', 'weekly_digest', 'backup_ready')),
  title         text not null check (length(title) between 1 and 200),
  body          text not null default '' check (length(body) <= 1000),
  link          text check (length(link) <= 500),
  dedupe_key    text not null check (length(dedupe_key) <= 300),
  -- Nothing goes out before this: the end of quiet hours, if it was written during them.
  deliver_after timestamptz not null default now(),
  -- Null is waiting; otherwise what happened on that channel.
  email_status  text check (email_status in ('sent', 'off', 'capped', 'failed', 'none')),
  push_status   text check (push_status in ('sent', 'off', 'capped', 'failed', 'none')),
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, user_id, dedupe_key)
);
create index notification_inbox on app.notification (workspace_id, user_id, created_at desc);
create index notification_waiting on app.notification (deliver_after)
  where email_status is null or push_status is null;

create table app.notification_pref (
  user_id                  uuid primary key references app.app_user (id) on delete cascade,
  -- { "<type>": { "inApp": bool, "email": bool, "push": bool } }; a missing type uses the defaults.
  channels                 jsonb not null default '{}',
  -- Minutes after local midnight; both null means no quiet hours.
  quiet_start              smallint default 1320 check (quiet_start between 0 and 1439),
  quiet_end                smallint default 420 check (quiet_end between 0 and 1439),
  daily_cap                smallint not null default 5 check (daily_cap between 0 and 50),
  digest_weekday           smallint not null default 1 check (digest_weekday between 1 and 7),
  large_transaction_minor  bigint not null default 50000 check (large_transaction_minor >= 0),
  low_balance_days         smallint not null default 14 check (low_balance_days between 1 and 90),
  import_reminder_days     smallint not null default 9 check (import_reminder_days between 1 and 90),
  email_unsubscribed_at    timestamptz,
  version                  bigint not null default 1,
  updated_at               timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- AUTH-12: what happened to this account. Append-only, like the audit log.
-- -----------------------------------------------------------------------------
create table app.security_event (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app.app_user (id) on delete cascade,
  workspace_id  uuid references app.workspace (id) on delete set null,
  kind          text not null check (kind in ('sign_in_new_device', 'mfa_changed', 'password_changed', 'email_changed',
                  'session_revoked', 'export_requested', 'export_downloaded', 'backup_scheduled', 'restore_started',
                  'restore_finished', 'deletion_requested', 'deletion_cancelled', 'support_access')),
  detail        jsonb not null default '{}',
  at            timestamptz not null default now()
);
create index security_event_user on app.security_event (user_id, at desc);

-- -----------------------------------------------------------------------------
-- BAK-04, NFR-06, RPT-04: archives made for someone, kept 7 days.
-- -----------------------------------------------------------------------------
create table app.export_job (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  requested_by  uuid not null references app.app_user (id),
  kind          text not null check (kind in ('backup', 'tax_package')),
  entity_id     uuid,
  tax_year      integer check (tax_year between 2000 and 2100),
  status        text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  encrypted     boolean not null default false,
  storage_key   text,
  file_name     text,
  bytes         bigint check (bytes >= 0),
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  expires_at    timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);
create index export_job_list on app.export_job (workspace_id, requested_by, created_at desc);
create index export_job_expiry on app.export_job (expires_at) where status = 'ready';

-- BAK-05: a backup on a schedule. The destination is a column so a drive connector is an addition (ADR-0019 §11).
create table app.backup_schedule (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  user_id       uuid not null references app.app_user (id),
  cadence       text not null check (cadence in ('weekly', 'monthly')),
  destination   text not null default 'email_link' check (destination in ('email_link')),
  next_run_on   date not null,
  last_run_at   timestamptz,
  version       bigint not null default 1,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- -----------------------------------------------------------------------------
-- BAK-06: a restore belongs to its user: the workspace it makes doesn't exist yet.
-- -----------------------------------------------------------------------------
create table app.restore_job (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app.app_user (id) on delete cascade,
  status        text not null default 'uploaded' check (status in ('uploaded', 'ready', 'restoring', 'done', 'failed')),
  storage_key   text not null,
  -- The upload is re-encrypted under a key of its own, wrapped by the KMS port; a backup's password isn't kept.
  wrapped_key   bytea not null,
  preview       jsonb,
  mode          text check (mode in ('new', 'existing')),
  target_workspace_id uuid,
  result        jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  expires_at    timestamptz not null default now() + interval '7 days'
);
create index restore_job_user on app.restore_job (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- BAK-08, BAK-09: quotas and deletion.
-- -----------------------------------------------------------------------------
alter table app.workspace add column storage_quota_bytes bigint not null default 5368709120 check (storage_quota_bytes >= 0);
alter table app.workspace add column deleted_at timestamptz;
alter table app.workspace add column purge_after timestamptz;
alter table app.app_user add column purge_after timestamptz;

-- Files and transactions in the trash, and what's due to go: read across workspaces by the retention job.
create index workspace_purge on app.workspace (purge_after) where purge_after is not null;
create index app_user_purge on app.app_user (purge_after) where purge_after is not null;
create index file_trash on app.file (deleted_at) where deleted_at is not null;
create index transaction_trash on app.transaction (deleted_at) where deleted_at is not null;

-- -----------------------------------------------------------------------------
-- Row level security.
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['saved_report', 'notification', 'notification_pref', 'security_event', 'export_job',
                           'backup_schedule', 'restore_job'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
end $$;

create policy saved_report_own on app.saved_report for all
  using (workspace_id = app.current_workspace_id() and user_id = app.current_user_id())
  with check (workspace_id = app.current_workspace_id() and user_id = app.current_user_id());
create policy notification_own on app.notification for all
  using (workspace_id = app.current_workspace_id() and user_id = app.current_user_id())
  with check (workspace_id = app.current_workspace_id() and user_id = app.current_user_id());
create policy notification_pref_own on app.notification_pref for all
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy security_event_select on app.security_event for select using (user_id = app.current_user_id());
create policy security_event_insert on app.security_event for insert with check (user_id = app.current_user_id());
create policy export_job_own on app.export_job for all
  using (workspace_id = app.current_workspace_id() and requested_by = app.current_user_id())
  with check (workspace_id = app.current_workspace_id() and requested_by = app.current_user_id());
create policy backup_schedule_own on app.backup_schedule for all
  using (workspace_id = app.current_workspace_id() and user_id = app.current_user_id())
  with check (workspace_id = app.current_workspace_id() and user_id = app.current_user_id());
create policy restore_job_own on app.restore_job for all
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

grant select, insert, update, delete on app.saved_report, app.notification, app.notification_pref, app.export_job,
  app.backup_schedule, app.restore_job to montra_app;
grant select, insert on app.security_event to montra_app;

-- -----------------------------------------------------------------------------
-- Background work that spans workspaces. Each of these returns only what the job needs to find, and the job then
-- works under the right user's RLS, except purging, whose whole point is to remove what RLS would otherwise guard.
-- -----------------------------------------------------------------------------

-- Who has notifications waiting to go out.
create function app.notifications_waiting(p_limit integer)
  returns table (workspace_id uuid, user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select distinct n.workspace_id, n.user_id
    from app.notification n
   where (n.email_status is null or n.push_status is null) and n.deliver_after <= now()
   limit p_limit
$$;
grant execute on function app.notifications_waiting(integer) to montra_app;

-- Active members of a workspace, each of whom gets their own notifications under their own RLS.
create function app.workspace_active_members(p_workspace uuid)
  returns table (user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select m.user_id from app.workspace_member m
    join app.app_user u on u.id = m.user_id
   where m.workspace_id = p_workspace and m.status = 'active' and u.deleted_at is null
$$;
grant execute on function app.workspace_active_members(uuid) to montra_app;

-- Scheduled backups due today in their workspace's time zone.
create function app.backup_schedules_due()
  returns table (workspace_id uuid, user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select s.workspace_id, s.user_id from app.backup_schedule s
    join app.workspace w on w.id = s.workspace_id
   where w.deleted_at is null and s.next_run_on <= (now() at time zone w.time_zone)::date
$$;
grant execute on function app.backup_schedules_due() to montra_app;

-- What retention has to do: expired archives, files past their retention, and accounts past their 30 days.
create function app.retention_due()
  returns table (kind text, workspace_id uuid, id uuid, storage_key text)
  language sql stable security definer set search_path = app, pg_temp as $$
  select 'export', e.workspace_id, e.id, e.storage_key from app.export_job e
   where e.status = 'ready' and e.expires_at < now()
  union all
  select 'restore', null::uuid, r.id, r.storage_key from app.restore_job r where r.expires_at < now()
  union all
  select 'file', f.workspace_id, f.id, f.storage_key from app.file f
   where (f.deleted_at < now() - interval '30 days') or f.retain_until < current_date
  union all
  select 'workspace', w.id, w.id, null from app.workspace w where w.purge_after < now()
  union all
  select 'user', null::uuid, u.id, null from app.app_user u where u.purge_after < now()
$$;
grant execute on function app.retention_due() to montra_app;

-- An archive past its 7 days, gone from storage.
create function app.expire_export(p_workspace uuid, p_id uuid) returns void
  language sql volatile security definer set search_path = app, pg_temp as $$
  update app.export_job set status = 'expired', storage_key = null where workspace_id = p_workspace and id = p_id
$$;
grant execute on function app.expire_export(uuid, uuid) to montra_app;

create function app.delete_expired_restore(p_id uuid) returns void
  language sql volatile security definer set search_path = app, pg_temp as $$
  delete from app.restore_job where id = p_id and expires_at < now()
$$;
grant execute on function app.delete_expired_restore(uuid) to montra_app;

-- A file past its time. Whatever still points at one keeps pointing: the row goes, and a reference shows it's gone.
create function app.purge_file(p_workspace uuid, p_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  delete from app.file where workspace_id = p_workspace and id = p_id;
  return true;
exception when foreign_key_violation then
  -- Still attached to a live record: keep the row and clear its date so it isn't looked at every night.
  update app.file set deleted_at = null, retain_until = null where workspace_id = p_workspace and id = p_id;
  return false;
end $$;
grant execute on function app.purge_file(uuid, uuid) to montra_app;

-- Transactions in the trash for over 30 days that no ledger entry still needs (ADR-0019 §13).
create function app.purge_trash() returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare n integer := 0; r record;
begin
  for r in select t.workspace_id, t.id from app.transaction t
            where t.deleted_at < now() - interval '30 days'
              and not exists (select 1 from app.journal_entry e
                               where e.workspace_id = t.workspace_id and e.transaction_id = t.id) loop
    begin
      delete from app.transaction where workspace_id = r.workspace_id and id = r.id;
      n := n + 1;
    exception when foreign_key_violation then
      null; -- Something still refers to it (a receipt, say); it stays in the trash for now.
    end;
  end loop;
  return n;
end $$;
grant execute on function app.purge_trash() to montra_app;

-- The storage keys of a workspace about to go.
create function app.workspace_storage_keys(p_workspace uuid) returns setof text
  language sql stable security definer set search_path = app, pg_temp as $$
  select f.storage_key from app.file f
   where f.workspace_id = p_workspace and exists (select 1 from app.workspace w where w.id = p_workspace and w.purge_after < now())
  union all
  select e.storage_key from app.export_job e
   where e.workspace_id = p_workspace and e.storage_key is not null
     and exists (select 1 from app.workspace w where w.id = p_workspace and w.purge_after < now())
$$;
grant execute on function app.workspace_storage_keys(uuid) to montra_app;

-- Removes a workspace past its 30 days and everything in it. Deleting the workspace cascades, and the ledger's guards and the
-- feeds already let a cascade through; tables with no foreign key to it are cleared after. Refused for anything not yet due.
create function app.purge_workspace(p_workspace uuid) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare t record;
begin
  if not exists (select 1 from app.workspace w where w.id = p_workspace and w.purge_after < now()) then
    raise exception 'workspace % is not due for purging', p_workspace;
  end if;
  perform set_config('app.allow_locked_edit', 'on', true);
  delete from app.workspace where id = p_workspace;
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
           where n.nspname = 'app' and c.relkind = 'r' loop
    execute format('delete from app.%I where workspace_id = $1', t.relname) using p_workspace;
  end loop;
end $$;
grant execute on function app.purge_workspace(uuid) to montra_app;

-- A user past their 30 days: rows elsewhere may still name them, so the row stays with nothing in it to identify them.
create function app.purge_user(p_user uuid) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if not exists (select 1 from app.app_user u where u.id = p_user and u.purge_after < now()) then
    raise exception 'user % is not due for purging', p_user;
  end if;
  update app.workspace_member set status = 'revoked', invited_email = null where user_id = p_user;
  delete from app.push_device where user_id = p_user;
  delete from app.session_device where user_id = p_user;
  delete from app.notification_pref where user_id = p_user;
  delete from app.security_event where user_id = p_user;
  delete from app.restore_job where user_id = p_user;
  update app.app_user
     set email = 'deleted+' || id::text || '@invalid.example', display_name = '', identity_id = null,
         date_format = null, purge_after = null
   where id = p_user;
end $$;
grant execute on function app.purge_user(uuid) to montra_app;
