-- Statements and bills find their account or biller, and learn it (ADR-0051).
--
-- A statement uploaded without an account, or a bill scanned to be filed automatically, is an intake: read once, matched
-- against the workspace's accounts or billers, then imported or filed automatically when its signal is learned and
-- nothing needs a decision. Otherwise it waits in Review. The match memory counts confirmations per signal.

-- -----------------------------------------------------------------------------
-- Intakes. The workspace's, not the uploader's, because Review is shared.
-- -----------------------------------------------------------------------------
create table app.document_intake (
  workspace_id     uuid not null references app.workspace (id) on delete cascade,
  id               uuid not null default gen_random_uuid(),
  kind             text not null check (kind in ('statement', 'bill')),
  file_ids         uuid[] not null check (cardinality(file_ids) between 1 and 20),
  file_name        text not null,
  file_type        text not null check (file_type in ('csv', 'xlsx', 'xls', 'pdf', 'qif', 'ofx', 'image')),
  -- reading → suggested (one candidate to confirm) | review (a decision) | importing (an import is being made) → done;
  -- or dismissed.
  status           text not null default 'reading'
                   check (status in ('reading', 'suggested', 'review', 'importing', 'done', 'dismissed')),
  -- Why it's in Review: no_match, several, unreadable, needs_mapping, duplicates, errors, balance, nothing_new,
  -- import_failed, undone, bill_incomplete.
  reason           text,
  -- The most specific detail the file gives (ADR-0051 §2), the key of its match memory; null when there is none.
  signal           text,
  -- What was found: digits, issuer, file-name pattern, candidates with reasons, and for a bill its amount and dates.
  detected         jsonb,
  -- The reading to import or file from (the doc-worker's result for a PDF, XLS or photo; a bill's extraction), so the
  -- document isn't read twice. Cleared once it's used.
  reading          jsonb,
  -- The account or biller suggested, then chosen.
  target_id        uuid,
  -- Chosen by the match memory, not by a person.
  automatic        boolean not null default false,
  -- Commit the import when it is clean (automatic, or confirmed from the phone).
  commit_if_clean  boolean not null default false,
  import_batch_id  uuid,
  -- A bill's scan (its uploader's own) and what filing it made.
  scan_id          uuid,
  filed            jsonb,
  job_id           uuid,
  created_by       uuid references app.app_user (id),
  resolved_by      uuid references app.app_user (id),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (workspace_id, id)
);

create index document_intake_open on app.document_intake (workspace_id, status, created_at desc);
create index document_intake_batch on app.document_intake (workspace_id, import_batch_id) where import_batch_id is not null;
create index document_intake_scan on app.document_intake (workspace_id, scan_id) where scan_id is not null;

-- -----------------------------------------------------------------------------
-- The match memory: per workspace, kind and signal, the target it points to and how many confirmations in a row.
-- -----------------------------------------------------------------------------
create table app.match_memory (
  workspace_id       uuid not null references app.workspace (id) on delete cascade,
  id                 uuid not null default gen_random_uuid(),
  kind               text not null check (kind in ('statement', 'bill')),
  signal             text not null check (length(signal) between 1 and 300),
  -- An account (statements) or a biller (bills).
  target_id          uuid not null,
  confirmations      integer not null default 0 check (confirmations >= 0),
  last_confirmed_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, kind, signal)
);

-- -----------------------------------------------------------------------------
-- A bill scan can ask to be filed automatically once its biller is learned. Off by default, so scans made by the
-- Add a bill dialogs keep waiting for their confirmation.
-- -----------------------------------------------------------------------------
alter table app.document_scan add column auto_file boolean not null default false;

-- -----------------------------------------------------------------------------
-- Row-level security: any member reads; statements are written by the roles that import files, bills also by members.
-- -----------------------------------------------------------------------------
alter table app.document_intake enable row level security;
alter table app.document_intake force row level security;
alter table app.match_memory enable row level security;
alter table app.match_memory force row level security;

create policy document_intake_select on app.document_intake for select
  using (workspace_id = app.current_workspace_id() and app.is_member());
create policy document_intake_write on app.document_intake for all
  using (workspace_id = app.current_workspace_id()
         and (app.current_member_role() in ('owner', 'admin', 'partner', 'accountant')
              or (kind = 'bill' and app.current_member_role() = 'member')))
  with check (workspace_id = app.current_workspace_id()
              and (app.current_member_role() in ('owner', 'admin', 'partner', 'accountant')
                   or (kind = 'bill' and app.current_member_role() = 'member')));

create policy match_memory_select on app.match_memory for select
  using (workspace_id = app.current_workspace_id() and app.is_member());
create policy match_memory_write on app.match_memory for all
  using (workspace_id = app.current_workspace_id()
         and (app.current_member_role() in ('owner', 'admin', 'partner', 'accountant')
              or (kind = 'bill' and app.current_member_role() = 'member')))
  with check (workspace_id = app.current_workspace_id()
              and (app.current_member_role() in ('owner', 'admin', 'partner', 'accountant')
                   or (kind = 'bill' and app.current_member_role() = 'member')));

grant select, insert, update, delete on app.document_intake to montra_app;
grant select, insert, update, delete on app.match_memory to montra_app;
