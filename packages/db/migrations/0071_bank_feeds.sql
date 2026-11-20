-- Bank feeds per workspace, PR 1 (ADR-0055; FEED-01..10): the contracts only. SimpleFIN Bridge is the first provider.
-- The person connects their banks at the Bridge and gives Montra a setup token; Montra claims it once and keeps the
-- access URL it gets back, sealed. Nothing here connects, links or imports yet: PR 2 connects and links, PR 3 syncs.
--
-- SimpleFIN's limits (requests a day, the 90-day window, the overlap, the hosts Montra may reach) are the API's
-- settings (SIMPLEFIN_*), not columns: they can change without a code change or a migration.

-- -----------------------------------------------------------------------------
-- §2: the connection. One live feed per workspace and provider; a disconnected one stays, with its secret wiped, so
-- its accounts' links survive 30 days for a reconnect (§3).
-- -----------------------------------------------------------------------------
create table app.bank_feed (
  workspace_id          uuid not null references app.workspace (id) on delete cascade,
  id                    uuid not null default gen_random_uuid(),
  provider              text not null check (provider in ('simplefin')),
  status                text not null default 'active'
                          check (status in ('active', 'needs_attention', 'revoked', 'payment_required', 'paused',
                                            'failing', 'disconnected')),
  -- The access URL, sealed with FieldCrypto (bound to `bank_feed.secret`). Null once disconnected.
  secret_enc            bytea,
  -- The access URL's host, not secret: shown in Settings and checked against the allowed hosts on every request.
  host                  text check (length(host) <= 253),
  label                 text check (length(label) <= 100),
  connected_by          uuid references app.app_user (id),
  connected_at          timestamptz not null default now(),
  disconnected_at       timestamptz,
  -- §5: the minute of the workspace's local day the daily sync runs at, chosen at random when connecting.
  sync_minute           smallint not null check (sync_minute between 0 and 1439),
  last_sync_at          timestamptz,
  last_success_at       timestamptz,
  next_sync_at          timestamptz,
  -- Sync now (§5): the last one asked for, to keep them an interval apart.
  last_manual_sync_at   timestamptz,
  attempts              integer not null default 0 check (attempts >= 0),
  last_error            text check (length(last_error) <= 500),
  -- §7: owners are told once per problem; cleared when it's fixed.
  attention_notified_at timestamptz,
  -- §5: requests made on `requests_day` (UTC), against the daily budget.
  requests_day          date,
  requests_today        integer not null default 0 check (requests_today >= 0),
  version               bigint not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint bank_feed_disconnected check ((status = 'disconnected') = (disconnected_at is not null)),
  constraint bank_feed_secret_held check (status = 'disconnected' or secret_enc is not null)
);
create unique index bank_feed_one_live on app.bank_feed (workspace_id, provider) where status <> 'disconnected';
create index bank_feed_due_idx on app.bank_feed (next_sync_at) where status in ('active', 'failing');

-- -----------------------------------------------------------------------------
-- §2, §4: each account the provider reports. Linked to a Montra account, ignored, or new (not decided yet). Only
-- linked accounts are fetched for import; the others keep a name and a balance.
-- -----------------------------------------------------------------------------
create table app.bank_feed_account (
  workspace_id            uuid not null references app.workspace (id) on delete cascade,
  id                      uuid not null default gen_random_uuid(),
  bank_feed_id            uuid not null,
  provider_account_id     text not null check (length(provider_account_id) between 1 and 200),
  provider_institution_id text check (length(provider_institution_id) <= 200),
  name                    text not null check (length(name) <= 200),
  institution_name        text check (length(institution_name) <= 200),
  -- ISO 4217; null for a custom (non-ISO) currency, which can't be linked (§1).
  currency                char(3),
  ledger_account_id       uuid,
  state                   text not null default 'new' check (state in ('new', 'linked', 'ignored')),
  -- §5: the first date the feed imports, chosen when linking, and the cursor: imported or waiting through this date.
  start_date              date,
  synced_through          date,
  last_balance_minor      bigint,
  last_available_minor    bigint,
  balance_date            date,
  -- §7: a problem on this account or its institution, typed, with the provider's words sanitized.
  problem                 text check (problem in ('reauth_needed', 'account_failed', 'missing_data', 'unknown')),
  last_error              text check (length(last_error) <= 500),
  -- §7: "No longer in your SimpleFIN Bridge": stays linked, unfetched.
  missing_since           timestamptz,
  last_seen_at            timestamptz,
  version                 bigint not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, bank_feed_id) references app.bank_feed (workspace_id, id) on delete cascade,
  foreign key (workspace_id, ledger_account_id) references app.ledger_account (workspace_id, id)
    on delete set null (ledger_account_id),
  constraint bank_feed_account_start check (state <> 'linked' or start_date is not null),
  constraint bank_feed_account_currency check (currency is null or currency ~ '^[A-Z]{3}$')
);
create unique index bank_feed_account_provider on app.bank_feed_account (workspace_id, bank_feed_id, provider_account_id);
-- One feed per Montra account (§2).
create unique index bank_feed_account_ledger on app.bank_feed_account (workspace_id, ledger_account_id)
  where state = 'linked' and ledger_account_id is not null;

-- -----------------------------------------------------------------------------
-- §2: one row per sync, kept 90 days. What it used and what it made; never a provider response.
-- -----------------------------------------------------------------------------
create table app.bank_feed_run (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  bank_feed_id  uuid not null,
  trigger       text not null check (trigger in ('connect', 'first', 'schedule', 'manual')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  outcome       text not null default 'running'
                  check (outcome in ('running', 'ok', 'partial', 'held', 'failed')),
  requests      integer not null default 0 check (requests >= 0),
  accounts      integer not null default 0 check (accounts >= 0),
  batches       integer not null default 0 check (batches >= 0),
  rows_read     integer not null default 0 check (rows_read >= 0),
  error         text check (length(error) <= 500),
  primary key (workspace_id, id),
  foreign key (workspace_id, bank_feed_id) references app.bank_feed (workspace_id, id) on delete cascade
);
create index bank_feed_run_recent on app.bank_feed_run (workspace_id, bank_feed_id, started_at desc);

-- -----------------------------------------------------------------------------
-- §2, §5: a feed's sync makes an import batch per account, with no file. `bank_feed_account_id` has no foreign key:
-- archives include feed batches but not feeds (§8), so a restored batch keeps an id that points nowhere.
-- -----------------------------------------------------------------------------
alter table app.import_batch add column source text not null default 'file' check (source in ('file', 'feed'));
alter table app.import_batch add column bank_feed_account_id uuid;
alter table app.import_batch alter column file_id drop not null;
alter table app.import_batch drop constraint import_batch_file_type_check;
alter table app.import_batch add constraint import_batch_file_type_check
  check (file_type in ('csv', 'xlsx', 'xls', 'pdf', 'qif', 'ofx', 'feed'));
alter table app.import_batch add constraint import_batch_source_file
  check ((source = 'file') = (file_id is not null) and (source = 'feed') = (file_type = 'feed'));
create index import_batch_feed_account on app.import_batch (workspace_id, bank_feed_account_id)
  where bank_feed_account_id is not null;

-- -----------------------------------------------------------------------------
-- §5: what the sync job (`bankfeed.sync`, PR 3) has to do, as the vault's functions: feeds whose sync is due, with an
-- owner to act as (the one who connected it first).
-- -----------------------------------------------------------------------------
create function app.bank_feed_due()
  returns table (workspace_id uuid, bank_feed_id uuid, user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select f.workspace_id, f.id,
         (select m.user_id from app.workspace_member m
           where m.workspace_id = f.workspace_id and m.role = 'owner' and m.status = 'active'
           order by (m.user_id = f.connected_by) desc, m.user_id limit 1)
    from app.bank_feed f
    join app.workspace w on w.id = f.workspace_id
   where w.deleted_at is null and f.status in ('active', 'failing') and f.next_sync_at <= now()
$$;
revoke all on function app.bank_feed_due() from public;
grant execute on function app.bank_feed_due() to montra_app;

create function app.bank_feed_next() returns timestamptz
  language sql stable security definer set search_path = app, pg_temp as $$
  select min(f.next_sync_at) from app.bank_feed f
    join app.workspace w on w.id = f.workspace_id
   where w.deleted_at is null and f.status in ('active', 'failing')
$$;
revoke all on function app.bank_feed_next() from public;
grant execute on function app.bank_feed_next() to montra_app;

-- -----------------------------------------------------------------------------
-- RLS (§2, D5). The feed and its runs: owners, admins and partners read; owners write (connecting, linking and the
-- sync, which acts as an owner). The accounts: whoever may import statements reads (AUTH-18); owners write. Nothing
-- for staff.
-- -----------------------------------------------------------------------------
alter table app.bank_feed enable row level security;
alter table app.bank_feed force row level security;
alter table app.bank_feed_account enable row level security;
alter table app.bank_feed_account force row level security;
alter table app.bank_feed_run enable row level security;
alter table app.bank_feed_run force row level security;

create policy bank_feed_read on app.bank_feed for select
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'admin', 'partner'));
create policy bank_feed_owner on app.bank_feed for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');

create policy bank_feed_account_read on app.bank_feed_account for select
  using (workspace_id = app.current_workspace_id()
         and app.current_member_role() in ('owner', 'admin', 'partner', 'accountant'));
create policy bank_feed_account_owner on app.bank_feed_account for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');

create policy bank_feed_run_read on app.bank_feed_run for select
  using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'admin', 'partner'));
create policy bank_feed_run_owner on app.bank_feed_run for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');

grant select, insert, update, delete on app.bank_feed, app.bank_feed_account, app.bank_feed_run to montra_app;

-- -----------------------------------------------------------------------------
-- §2, §7: the security log and notifications. The API's lists gain these with the PRs that write them.
-- -----------------------------------------------------------------------------
alter table app.security_event drop constraint security_event_kind_check;
alter table app.security_event add constraint security_event_kind_check
  check (kind in ('sign_in_new_device', 'mfa_changed', 'password_changed', 'email_changed',
                  'session_revoked', 'export_requested', 'export_downloaded', 'backup_scheduled', 'restore_started',
                  'restore_finished', 'deletion_requested', 'deletion_cancelled', 'support_access',
                  'storage_connected', 'storage_changed', 'storage_disconnected', 'sign_in_locked',
                  'account_suspended', 'account_restored', 'deletion_requested_by_support', 'phone_changed',
                  'vault_connected', 'vault_changed', 'vault_key_replaced', 'vault_move_started',
                  'vault_disconnected', 'bank_feed_connected', 'bank_feed_changed', 'bank_feed_disconnected'));

alter table app.notification drop constraint notification_type_check;
alter table app.notification add constraint notification_type_check
  check (type in ('bill_due', 'low_balance', 'overspend_pace', 'large_transaction',
                  'rent_overdue', 'lease_expiring', 'import_reminder', 'monthly_review', 'tax_due', 'reminder',
                  'suggestion', 'weekly_digest', 'backup_ready', 'storage_failing', 'ai_allowance',
                  'tax_forms_missing', 'vault_attention', 'files_missing', 'bank_feed_attention'));

-- -----------------------------------------------------------------------------
-- §11, D6: the `bankFeeds` plan key, on wherever `ownStorage` is (the person pays SimpleFIN). Hidden from customers
-- (FEATURES_NOT_YET_SHOWN) until syncing works end to end. As migration 0063 did for `familyVault`, the freeze on
-- versions with subscribers is lifted for this one update: adding a feature takes nothing away.
-- -----------------------------------------------------------------------------
alter table app.plan_version disable trigger plan_version_frozen;
update app.plan_version
   set entitlements = jsonb_set(entitlements, '{features}', (entitlements -> 'features') || '["bankFeeds"]'::jsonb)
 where (entitlements -> 'features') @> '["ownStorage"]'::jsonb
   and not (entitlements -> 'features') @> '["bankFeeds"]'::jsonb;
alter table app.plan_version enable trigger plan_version_frozen;
