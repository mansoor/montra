-- Your own storage for files and backups (BAK-03, BAK-05; ADR-0031). Montra keeps its copy of every file and also writes one to
-- storage the owner connects (S3-compatible or WebDAV for now). Backups can go there too, on demand or on a schedule.

-- -----------------------------------------------------------------------------
-- The connection. Owners only. The secret is sealed with the workspace's field key and never read back to a client.
-- -----------------------------------------------------------------------------
create table app.storage_destination (
  workspace_id        uuid not null references app.workspace (id) on delete cascade,
  id                  uuid not null default gen_random_uuid(),
  kind                text not null check (kind in ('s3', 'webdav')),
  label               text not null check (length(label) between 1 and 80),
  -- What isn't secret, shown back to the owner: { endpoint, region, bucket, pathStyle } or { url, username }.
  config              jsonb not null default '{}'::jsonb,
  -- { accessKeyId, secretAccessKey } or { password }, sealed by FieldCrypto as 'storage_destination.secret'.
  secret_enc          bytea not null,
  -- Shown so the owner can tell keys apart: the last four characters of an S3 access key id.
  secret_hint         text check (length(secret_hint) <= 8),
  -- Everything goes under this folder, e.g. 'Montra/Smith household'. Saved at connect time.
  folder              text not null check (length(folder) between 1 and 200 and folder !~ '(^/|/$|\.\.|\\|//)'),
  mirror_files        boolean not null default true,
  file_kinds          text[] not null default array['statement', 'receipt', 'payslip', 'lease', 'invoice', 'other']
                        check (file_kinds <@ array['statement', 'receipt', 'payslip', 'lease', 'invoice', 'other']),
  -- ADR-0031 §6: off means a copy outlives Montra's file.
  delete_with_montra  boolean not null default false,
  -- Archives Montra wrote to backups/ that it keeps; 0 keeps them all.
  keep_backups        integer not null default 12 check (keep_backups between 0 and 1000),
  -- The connection check found Montra may delete there. Pruning and delete_with_montra need it.
  can_delete          boolean not null default true,
  status              text not null default 'active' check (status in ('active', 'paused', 'failing')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_success_at     timestamptz,
  last_error          text check (length(last_error) <= 500),
  last_error_at       timestamptz,
  created_by          uuid references app.app_user (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             bigint not null default 1,
  primary key (workspace_id, id)
);
-- One connection per workspace for now; the id leaves room for more.
create unique index storage_destination_one on app.storage_destination (workspace_id);

-- -----------------------------------------------------------------------------
-- The outbox: one row per file and connection. No foreign key to the file, so that a copy to delete can outlive the file's row.
-- -----------------------------------------------------------------------------
create table app.storage_mirror_item (
  workspace_id    uuid not null,
  destination_id  uuid not null,
  file_id         uuid not null,
  status          text not null default 'pending' check (status in ('pending', 'done', 'failed', 'skipped', 'delete')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error      text check (length(last_error) <= 500),
  remote_path     text check (length(remote_path) <= 1024),
  bytes           bigint check (bytes >= 0),
  mirrored_at     timestamptz,
  created_at      timestamptz not null default now(),
  primary key (workspace_id, destination_id, file_id),
  foreign key (workspace_id, destination_id) references app.storage_destination (workspace_id, id) on delete cascade
);
create index storage_mirror_due on app.storage_mirror_item (next_attempt_at) where status in ('pending', 'delete');
create index storage_mirror_file on app.storage_mirror_item (workspace_id, file_id);

-- -----------------------------------------------------------------------------
-- Backups to the connection (ADR-0031 §7).
-- -----------------------------------------------------------------------------
alter table app.export_job add column destination_id uuid;
alter table app.export_job add column destination_status text
  check (destination_status in ('pending', 'done', 'failed', 'pruned'));
alter table app.export_job add column destination_path text check (length(destination_path) <= 1024);
alter table app.export_job add column destination_error text check (length(destination_error) <= 500);
alter table app.export_job add column destination_attempts integer not null default 0;
alter table app.export_job add column destination_next_at timestamptz;
-- Made by a schedule: its owner hears how saving it went.
alter table app.export_job add column scheduled boolean not null default false;
alter table app.export_job
  add constraint export_job_destination foreign key (workspace_id, destination_id)
  references app.storage_destination (workspace_id, id) on delete set null (destination_id);
create index export_job_destination_due on app.export_job (destination_next_at) where destination_status = 'pending';

alter table app.backup_schedule drop constraint backup_schedule_destination_check;
alter table app.backup_schedule add constraint backup_schedule_destination_check
  check (destination in ('email_link', 'storage'));
-- A scheduled password: the scrypt-derived key wrapped by the KMS port, and its parameters. Never the password (ADR-0019 §8).
alter table app.backup_schedule add column wrapped_key bytea;
alter table app.backup_schedule add column kdf jsonb;

alter table app.security_event drop constraint security_event_kind_check;
alter table app.security_event add constraint security_event_kind_check
  check (kind in ('sign_in_new_device', 'mfa_changed', 'password_changed', 'email_changed',
                  'session_revoked', 'export_requested', 'export_downloaded', 'backup_scheduled', 'restore_started',
                  'restore_finished', 'deletion_requested', 'deletion_cancelled', 'support_access',
                  'storage_connected', 'storage_changed', 'storage_disconnected'));

alter table app.notification drop constraint notification_type_check;
alter table app.notification add constraint notification_type_check
  check (type in ('bill_due', 'low_balance', 'overspend_pace', 'large_transaction',
                  'rent_overdue', 'lease_expiring', 'import_reminder', 'monthly_review', 'tax_due', 'reminder',
                  'suggestion', 'weekly_digest', 'backup_ready', 'storage_failing'));

-- -----------------------------------------------------------------------------
-- RLS: owners only.
-- -----------------------------------------------------------------------------
alter table app.storage_destination enable row level security;
alter table app.storage_destination force row level security;
alter table app.storage_mirror_item enable row level security;
alter table app.storage_mirror_item force row level security;
create policy storage_destination_owner on app.storage_destination for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');
create policy storage_mirror_item_owner on app.storage_mirror_item for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');
grant select, insert, update, delete on app.storage_destination, app.storage_mirror_item to montra_app;

-- -----------------------------------------------------------------------------
-- Every way a file arrives (receipts, payslips, statements, business files, restores) lands here. Whoever uploads may not be
-- able to see the connection, so these run as definer.
-- -----------------------------------------------------------------------------
create function app.storage_file_added() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare queued integer;
begin
  if new.kind = 'export' then return null; end if;
  insert into app.storage_mirror_item (workspace_id, destination_id, file_id)
  select d.workspace_id, d.id, new.id from app.storage_destination d
   where d.workspace_id = new.workspace_id and d.mirror_files and d.status <> 'paused' and new.kind = any (d.file_kinds)
  on conflict do nothing;
  get diagnostics queued = row_count;
  if queued > 0 then
    perform app.schedule_system_job('schedule', 'storage.mirror', now());
  end if;
  return null;
end $$;
revoke all on function app.storage_file_added() from public;
create trigger file_storage_mirror after insert on app.file for each row execute function app.storage_file_added();

-- Back from the trash: a file skipped while it was there is copied after all.
create function app.storage_file_restored() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  if old.deleted_at is not null and new.deleted_at is null then
    update app.storage_mirror_item set status = 'pending', next_attempt_at = now(), attempts = 0
     where workspace_id = new.workspace_id and file_id = new.id and status = 'skipped';
    if found then perform app.schedule_system_job('schedule', 'storage.mirror', now()); end if;
  end if;
  return null;
end $$;
revoke all on function app.storage_file_restored() from public;
create trigger file_storage_restored after update of deleted_at on app.file
  for each row execute function app.storage_file_restored();

-- Deleted for good: the copy stays unless the owner asked otherwise (ADR-0031 §6).
create function app.storage_file_removed() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  update app.storage_mirror_item i set status = 'delete', next_attempt_at = now(), attempts = 0, last_error = null
    from app.storage_destination d
   where i.workspace_id = old.workspace_id and i.file_id = old.id and i.status = 'done'
     and d.workspace_id = i.workspace_id and d.id = i.destination_id and d.delete_with_montra and d.can_delete;
  if found then perform app.schedule_system_job('schedule', 'storage.mirror', now()); end if;
  delete from app.storage_mirror_item where workspace_id = old.workspace_id and file_id = old.id and status <> 'delete';
  return null;
end $$;
revoke all on function app.storage_file_removed() from public;
create trigger file_storage_removed after delete on app.file for each row execute function app.storage_file_removed();

-- What the mirror job has to do: connections with copies or deletions due, or a backup to send, each with an owner to act as.
create function app.storage_mirror_due()
  returns table (workspace_id uuid, destination_id uuid, user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select d.workspace_id, d.id,
         (select m.user_id from app.workspace_member m
           where m.workspace_id = d.workspace_id and m.role = 'owner' and m.status = 'active'
           order by (m.user_id = d.created_by) desc, m.user_id limit 1)
    from app.storage_destination d
    join app.workspace w on w.id = d.workspace_id
   where w.deleted_at is null and d.status <> 'paused'
     and (exists (select 1 from app.storage_mirror_item i
                   where i.workspace_id = d.workspace_id and i.destination_id = d.id
                     and i.status in ('pending', 'delete') and i.next_attempt_at <= now())
       or exists (select 1 from app.export_job e
                   where e.workspace_id = d.workspace_id and e.destination_id = d.id
                     and e.destination_status = 'pending' and coalesce(e.destination_next_at, now()) <= now()))
$$;
revoke all on function app.storage_mirror_due() from public;
grant execute on function app.storage_mirror_due() to montra_app;

-- When the job should next look: the earliest attempt still waiting anywhere, or null with nothing waiting.
create function app.storage_mirror_next() returns timestamptz
  language sql stable security definer set search_path = app, pg_temp as $$
  select min(t) from (
    select min(i.next_attempt_at) as t from app.storage_mirror_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.status in ('pending', 'delete') and d.status <> 'paused'
    union all
    select min(coalesce(e.destination_next_at, now())) from app.export_job e
      join app.storage_destination d on d.workspace_id = e.workspace_id and d.id = e.destination_id
     where e.destination_status = 'pending' and d.status <> 'paused'
  ) x
$$;
revoke all on function app.storage_mirror_next() from public;
grant execute on function app.storage_mirror_next() to montra_app;
