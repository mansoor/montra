-- The household's Family Document Vault as a storage provider, PR 1 (ADR-0054 §11; VLT-01..11): the contracts only.
-- A third kind of connection, `fdv`, beside the S3/WebDAV mirror; its state and its outbox; where a file is held and
-- whether it is missing; the trigger and job functions; the security log kinds and notification types; and the
-- `familyVault` plan key. Nothing creates a vault connection yet (PR 2), so nothing here changes what anyone sees.
--
-- `app.file.storage_key` stays NOT NULL for now. A file held only in the vault has no Montra object, but none exists
-- until PR 5 removes sources; every reader of `storage_key` moves to `FileBytes` then, in the same change that lets it
-- be null. The check that keeps it set for files Montra holds is added here, so PR 5 only drops the NOT NULL.

-- -----------------------------------------------------------------------------
-- §1, §11: the connection. One mirror (s3 or webdav) and one vault per workspace, instead of one connection.
-- -----------------------------------------------------------------------------
alter table app.storage_destination drop constraint storage_destination_kind_check;
alter table app.storage_destination add constraint storage_destination_kind_check
  check (kind in ('s3', 'webdav', 'fdv'));

-- `needs_vault`: waiting for approval, paused or removed on the vault's side, or a key waiting to be confirmed. The
-- vault's own words go in `last_error`.
alter table app.storage_destination drop constraint storage_destination_status_check;
alter table app.storage_destination add constraint storage_destination_status_check
  check (status in ('active', 'paused', 'failing', 'needs_vault'));
alter table app.storage_destination add constraint storage_destination_needs_vault
  check (status <> 'needs_vault' or kind = 'fdv');

drop index app.storage_destination_one;
create unique index storage_destination_one_mirror on app.storage_destination (workspace_id)
  where kind in ('s3', 'webdav');
create unique index storage_destination_one_vault on app.storage_destination (workspace_id) where kind = 'fdv';
-- What the vault's tables point at, so their rows can only hang off a vault connection.
create unique index storage_destination_kind on app.storage_destination (workspace_id, id, kind);

-- For `fdv`, `config` holds the vault's address and pinned identity, Montra's app and key identifiers there, the public
-- key and its fingerprint, the household's name as last reported, the role (`copy` or `record`), the backup choice
-- (`montra`, `own_storage`, `none`), each group's switch and vault kind, and "describe documents in more detail".
-- `secret_enc` holds the sealed private key (both, during a key change). `file_kinds` is derived from the groups that
-- are on; `mirror_files` is "send files to the vault"; `delete_with_montra` and `can_delete` mean what they mean for a
-- mirror. `folder` and `keep_backups` don't apply: backups never go to the vault (BAK-05 unchanged).

-- -----------------------------------------------------------------------------
-- §11: per vault connection, what the job keeps between runs. Not secret.
-- -----------------------------------------------------------------------------
create table app.vault_connection_state (
  workspace_id      uuid not null,
  destination_id    uuid not null,
  destination_kind  text not null default 'fdv' check (destination_kind = 'fdv'),
  -- §9: the changes feed's position, saved only after a page is processed, and when it was read.
  feed_cursor       text check (length(feed_cursor) <= 2000),
  feed_read_at      timestamptz,
  -- §9 "Starting over": the last time the whole feed was read again.
  full_read_at      timestamptz,
  -- §12.1: the last signed connection test that passed.
  checked_at        timestamptz,
  -- When the job should look at this connection for its own sake (the daily check, the feed), rows or not.
  next_check_at     timestamptz not null default now(),
  -- §12: the vault's next daily reset, and the holds for its daily caps. A hold is not a failure.
  daily_reset_at    timestamptz,
  send_held_until   timestamptz,
  read_held_until   timestamptz,
  -- §7: Montra's clock against the vault's, from its last answer. Positive: Montra is ahead.
  clock_offset_ms   integer check (abs(clock_offset_ms) <= 86400000),
  -- §2 "Replace the key": `made` (the new pair is sealed, not yet registered), `registered` (registered under the old
  -- key, waiting for the vault side to confirm it). Montra signs with the old key until then.
  key_rotation      text not null default 'none' check (key_rotation in ('none', 'made', 'registered')),
  key_rotation_at   timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (workspace_id, destination_id),
  check ((key_rotation = 'none') = (key_rotation_at is null)),
  foreign key (workspace_id, destination_id, destination_kind)
    references app.storage_destination (workspace_id, id, kind) on delete cascade
);

-- -----------------------------------------------------------------------------
-- §4, §11: the outbox, one row per file and vault connection. No foreign key to the file, so that a delete or a
-- withdrawal still to do can outlive the file's row (as `storage_mirror_item`).
--
--   queued        waiting for Montra to finish with the file (§3: reading, import, extraction, an open Review item)
--   pending       due to be sent, or sent with no answer yet (§4.4: ask about the id before sending again)
--   received      in someone's Inbox in the vault
--   filed         a vault document: `vault_document_id` says which
--   not_kept      removed from the Inbox, lapsed, or refused (§4.5); Montra keeps its copy
--   failed        gave up after its attempts, until "Try again"
--   out_of_reach  the vault says Montra may no longer see it (§9)
--   delete        to delete in the vault (a filed row, §10) or, with no `filed_at`, to withdraw from the Inbox
-- -----------------------------------------------------------------------------
create table app.vault_item (
  workspace_id      uuid not null,
  destination_id    uuid not null,
  destination_kind  text not null default 'fdv' check (destination_kind = 'fdv'),
  file_id           uuid not null,
  -- §4.1: chosen once, opaque (never a name or an amount), saved before the first send, and never changed.
  vault_ref         text check (length(vault_ref) between 1 and 200),
  status            text not null default 'queued'
                      check (status in ('queued', 'pending', 'received', 'filed', 'not_kept', 'failed',
                                        'out_of_reach', 'delete')),
  -- §4.5, in Montra's own words, and whether a person may send it again.
  not_kept_reason   text check (length(not_kept_reason) <= 500),
  resend_allowed    boolean not null default false,
  -- §4.5: a row that lapsed in the Inbox is sent again on its own at most once.
  auto_resends      integer not null default 0 check (auto_resends between 0 and 1),
  vault_document_id text check (length(vault_document_id) <= 200),
  vault_version     text check (length(vault_version) <= 200),
  -- §4.3: the vault's hash of what it received, checked against the file's.
  vault_sha256      text check (vault_sha256 ~ '^[0-9a-f]{64}$'),
  -- §9: what the vault calls the document, as last read from the feed. Never changes Montra's books.
  vault_meta        jsonb,
  received_at       timestamptz,
  filed_at          timestamptz,
  -- §5: Montra's object still to remove once the vault is the record, and when it was.
  source_key        text check (length(source_key) <= 1024),
  source_removed_at timestamptz,
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  last_error        text check (length(last_error) <= 500),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (workspace_id, destination_id, file_id),
  foreign key (workspace_id, destination_id, destination_kind)
    references app.storage_destination (workspace_id, id, kind) on delete cascade,
  -- Anything past sending has its id.
  check (status in ('queued', 'pending', 'failed') or vault_ref is not null),
  check (status <> 'filed' or (filed_at is not null and vault_document_id is not null)),
  check (status <> 'out_of_reach' or vault_document_id is not null),
  check (status <> 'not_kept' or not_kept_reason is not null),
  check (source_removed_at is null or source_key is not null)
);
create unique index vault_item_ref on app.vault_item (workspace_id, destination_id, vault_ref)
  where vault_ref is not null;
create index vault_item_due on app.vault_item (next_attempt_at)
  where status in ('queued', 'pending', 'received', 'delete');
create index vault_item_document on app.vault_item (workspace_id, destination_id, vault_document_id)
  where vault_document_id is not null;
create index vault_item_file on app.vault_item (workspace_id, file_id);
-- §5: sources still to remove after a crash between the commit and the delete.
create index vault_item_source on app.vault_item (workspace_id, destination_id)
  where source_key is not null and source_removed_at is null;

-- §4.1: once saved, the id stays, through retries and crashes.
create function app.vault_item_ref_fixed() returns trigger
  language plpgsql set search_path = app, pg_temp as $$
begin
  if old.vault_ref is not null and new.vault_ref is distinct from old.vault_ref then
    raise exception 'a vault item''s id is chosen once and never changes' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function app.vault_item_ref_fixed() from public;
create trigger vault_item_ref_fixed before update of vault_ref on app.vault_item
  for each row execute function app.vault_item_ref_fixed();

-- -----------------------------------------------------------------------------
-- §5, §5a, §11: where a file's bytes are, and whether a person has to provide it again.
-- -----------------------------------------------------------------------------
alter table app.file add column location text not null default 'montra' check (location in ('montra', 'vault'));
alter table app.file add constraint file_storage_key_held check (location = 'vault' or storage_key is not null);
alter table app.file add column missing_since timestamptz;
alter table app.file add column missing_reason text check (length(missing_reason) <= 500);
alter table app.file add constraint file_missing_reason check ((missing_since is null) = (missing_reason is null));
-- §5a: provided again with a different hash (a fresh scan of the same paper), noted rather than refused.
alter table app.file add column replaced_sha256 text check (replaced_sha256 ~ '^[0-9a-f]{64}$');
create index file_missing on app.file (workspace_id, missing_since) where missing_since is not null;

-- -----------------------------------------------------------------------------
-- §3, §6, §10, §11: the triggers from migrations 0029 and 0032, extended. Whoever uploads may not be able to see the
-- connections, so these run as definer.
-- -----------------------------------------------------------------------------

-- A stored file is copied to the mirror (as before, mirrors only) and queued for the vault when its group is on.
-- Sealed copies of identity documents, logos and exports never go (§6); `file_kinds` holds neither of the latter.
-- A vault row waits as `queued` until Montra is done with the file (§3), so nothing is scheduled here: the vault's
-- job looks at queued rows on its own runs.
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
  return null;
end $$;
revoke all on function app.storage_file_added() from public;

-- Deleted for good. The mirror as before (ADR-0031 §6). The vault (§10): a filed document is deleted there only when
-- the owner asked for that and the vault lets Montra delete; an item still in the Inbox is withdrawn, so the family
-- isn't asked about a file Montra no longer has; any other row goes.
create or replace function app.storage_file_removed() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  update app.storage_mirror_item i set status = 'delete', next_attempt_at = now(), attempts = 0, last_error = null
    from app.storage_destination d
   where i.workspace_id = old.workspace_id and i.file_id = old.id and i.status = 'done'
     and d.workspace_id = i.workspace_id and d.id = i.destination_id and d.delete_with_montra and d.can_delete;
  if found then perform app.schedule_system_job('schedule', 'storage.mirror', now()); end if;
  delete from app.storage_mirror_item where workspace_id = old.workspace_id and file_id = old.id and status <> 'delete';

  update app.vault_item i
     set status = 'delete', next_attempt_at = now(), attempts = 0, last_error = null, updated_at = now()
    from app.storage_destination d
   where i.workspace_id = old.workspace_id and i.file_id = old.id
     and d.workspace_id = i.workspace_id and d.id = i.destination_id
     and (i.status = 'received' or (i.status = 'filed' and d.delete_with_montra and d.can_delete));
  delete from app.vault_item where workspace_id = old.workspace_id and file_id = old.id and status <> 'delete';
  return null;
end $$;
revoke all on function app.storage_file_removed() from public;

-- The mirror's job looks only at mirrors.
create or replace function app.storage_mirror_due()
  returns table (workspace_id uuid, destination_id uuid, user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select d.workspace_id, d.id,
         (select m.user_id from app.workspace_member m
           where m.workspace_id = d.workspace_id and m.role = 'owner' and m.status = 'active'
           order by (m.user_id = d.created_by) desc, m.user_id limit 1)
    from app.storage_destination d
    join app.workspace w on w.id = d.workspace_id
   where w.deleted_at is null and d.kind in ('s3', 'webdav') and d.status <> 'paused'
     and (exists (select 1 from app.storage_mirror_item i
                   where i.workspace_id = d.workspace_id and i.destination_id = d.id
                     and i.status in ('pending', 'delete') and i.next_attempt_at <= now())
       or exists (select 1 from app.export_job e
                   where e.workspace_id = d.workspace_id and e.destination_id = d.id
                     and e.destination_status = 'pending' and coalesce(e.destination_next_at, now()) <= now()))
$$;
revoke all on function app.storage_mirror_due() from public;
grant execute on function app.storage_mirror_due() to montra_app;

create or replace function app.storage_mirror_next() returns timestamptz
  language sql stable security definer set search_path = app, pg_temp as $$
  select min(t) from (
    select min(i.next_attempt_at) as t from app.storage_mirror_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.status in ('pending', 'delete') and d.kind in ('s3', 'webdav') and d.status <> 'paused'
    union all
    select min(coalesce(e.destination_next_at, now())) from app.export_job e
      join app.storage_destination d on d.workspace_id = e.workspace_id and d.id = e.destination_id
     where e.destination_status = 'pending' and d.kind in ('s3', 'webdav') and d.status <> 'paused'
  ) x
$$;
revoke all on function app.storage_mirror_next() from public;
grant execute on function app.storage_mirror_next() to montra_app;

-- -----------------------------------------------------------------------------
-- §12: what the vault's job (`storage.vault`, PR 3) has to do, as the mirror's functions. A connection is due when a
-- row is, or when its own check or feed is. While it needs a person on the vault's side (`needs_vault`), only its
-- check counts: nothing is retried until the check passes again.
-- -----------------------------------------------------------------------------
create function app.vault_due()
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
       or (d.status in ('active', 'failing')
           and exists (select 1 from app.vault_item i
                        where i.workspace_id = d.workspace_id and i.destination_id = d.id
                          and i.status in ('queued', 'pending', 'received', 'delete')
                          and i.next_attempt_at <= now())))
$$;
revoke all on function app.vault_due() from public;
grant execute on function app.vault_due() to montra_app;

-- When the vault's job should next look: the earliest row or connection check waiting anywhere, or null.
create function app.vault_next() returns timestamptz
  language sql stable security definer set search_path = app, pg_temp as $$
  select min(t) from (
    select min(i.next_attempt_at) as t from app.vault_item i
      join app.storage_destination d on d.workspace_id = i.workspace_id and d.id = i.destination_id
     where i.status in ('queued', 'pending', 'received', 'delete') and d.status in ('active', 'failing')
    union all
    select min(coalesce(s.next_check_at, now())) from app.storage_destination d
      left join app.vault_connection_state s on s.workspace_id = d.workspace_id and s.destination_id = d.id
     where d.kind = 'fdv' and d.status <> 'paused'
  ) x
$$;
revoke all on function app.vault_next() from public;
grant execute on function app.vault_next() to montra_app;

-- -----------------------------------------------------------------------------
-- RLS: owners and admins only, as the connection and the mirror's outbox (migrations 0029, 0041). Nothing for staff.
-- -----------------------------------------------------------------------------
alter table app.vault_connection_state enable row level security;
alter table app.vault_connection_state force row level security;
alter table app.vault_item enable row level security;
alter table app.vault_item force row level security;
create policy vault_connection_state_admin on app.vault_connection_state for all
  using (workspace_id = app.current_workspace_id() and app.is_admin())
  with check (workspace_id = app.current_workspace_id() and app.is_admin());
create policy vault_item_admin on app.vault_item for all
  using (workspace_id = app.current_workspace_id() and app.is_admin())
  with check (workspace_id = app.current_workspace_id() and app.is_admin());
grant select, insert, update, delete on app.vault_connection_state, app.vault_item to montra_app;

-- -----------------------------------------------------------------------------
-- §11: the security log and notifications. The API's lists gain these with the PRs that write them.
-- -----------------------------------------------------------------------------
alter table app.security_event drop constraint security_event_kind_check;
alter table app.security_event add constraint security_event_kind_check
  check (kind in ('sign_in_new_device', 'mfa_changed', 'password_changed', 'email_changed',
                  'session_revoked', 'export_requested', 'export_downloaded', 'backup_scheduled', 'restore_started',
                  'restore_finished', 'deletion_requested', 'deletion_cancelled', 'support_access',
                  'storage_connected', 'storage_changed', 'storage_disconnected', 'sign_in_locked',
                  'account_suspended', 'account_restored', 'deletion_requested_by_support', 'phone_changed',
                  'vault_connected', 'vault_changed', 'vault_key_replaced', 'vault_move_started',
                  'vault_disconnected'));

alter table app.notification drop constraint notification_type_check;
alter table app.notification add constraint notification_type_check
  check (type in ('bill_due', 'low_balance', 'overspend_pace', 'large_transaction',
                  'rent_overdue', 'lease_expiring', 'import_reminder', 'monthly_review', 'tax_due', 'reminder',
                  'suggestion', 'weekly_digest', 'backup_ready', 'storage_failing', 'ai_allowance',
                  'tax_forms_missing', 'vault_attention', 'files_missing'));

-- -----------------------------------------------------------------------------
-- §11, D11: the `familyVault` plan key, on wherever `ownStorage` is. A new feature key gives every existing version a
-- default in the same migration (ADR-0049 §1); adding one takes nothing away from a subscriber, so the freeze on
-- versions with subscribers is lifted for this one update.
-- -----------------------------------------------------------------------------
alter table app.plan_version disable trigger plan_version_frozen;
update app.plan_version
   set entitlements = jsonb_set(entitlements, '{features}', (entitlements -> 'features') || '["familyVault"]'::jsonb)
 where (entitlements -> 'features') @> '["ownStorage"]'::jsonb
   and not (entitlements -> 'features') @> '["familyVault"]'::jsonb;
alter table app.plan_version enable trigger plan_version_frozen;
