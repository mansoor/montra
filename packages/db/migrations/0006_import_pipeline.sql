-- 0006_import_pipeline: files, the Postgres job queue (ADR-0011), statement imports, transaction sources,
-- payee aliases, reconciliation and reference data (Phase 2; design 03 §5, 04 §3).

-- ---------------------------------------------------------------------------------------------
-- Uploaded files (statements now; receipts and payslips later). Content lives in object storage.
-- ---------------------------------------------------------------------------------------------
create table app.file (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  kind          text not null check (kind in ('statement', 'receipt', 'payslip', 'lease', 'invoice', 'export', 'other')),
  storage_key   text not null,
  file_name     text not null check (length(file_name) between 1 and 255),
  mime          text not null,
  bytes         bigint not null check (bytes >= 0),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by   uuid references app.app_user (id),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (workspace_id, id)
);
create index file_sha on app.file (workspace_id, sha256);

-- ---------------------------------------------------------------------------------------------
-- Job queue (ADR-0011): SKIP LOCKED dequeue, LISTEN/NOTIFY wake-ups, retries with backoff, and optional
-- follow-up jobs. Consumed by the Node worker and the Python doc worker through definer functions.
-- ---------------------------------------------------------------------------------------------
create table app.job (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references app.workspace (id) on delete cascade,
  queue         text not null check (queue in ('import', 'doc', 'schedule', 'ai', 'report', 'notify')),
  type          text not null,
  payload       jsonb not null default '{}',
  status        text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority      integer not null default 0,
  run_after     timestamptz not null default now(),
  attempts      integer not null default 0,
  max_attempts  integer not null default 3,
  locked_by     text,
  locked_at     timestamptz,
  progress      integer check (progress between 0 and 100),
  result        jsonb,
  error         text,
  -- A job to enqueue when this one succeeds: { "queue": ..., "type": ..., "payload": {...} }.
  -- The follow-up's payload gets "previousJobId" and "previousResult" added.
  then_job      jsonb,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index job_ready on app.job (queue, priority desc, run_after) where status = 'queued';
create index job_workspace on app.job (workspace_id, created_at desc);

create function app.job_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('montra_jobs', new.queue);
  return null;
end $$;
create trigger job_notify after insert on app.job for each row execute function app.job_notify();

-- Claim the next ready job of a queue. Returns no row when the queue is empty.
create function app.dequeue_job(p_queue text, p_worker text) returns setof app.job
  language sql volatile security definer set search_path = app, pg_temp as $$
  update app.job j set status = 'running', attempts = j.attempts + 1, locked_by = p_worker, locked_at = now(), updated_at = now()
   where j.id = (select id from app.job
                  where queue = p_queue and status = 'queued' and run_after <= now()
                  order by priority desc, run_after, created_at
                  for update skip locked limit 1)
  returning j.*
$$;

create function app.complete_job(p_id uuid, p_result jsonb) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare j app.job;
begin
  update app.job set status = 'succeeded', result = p_result, progress = 100, finished_at = now(), updated_at = now(),
                     locked_by = null, locked_at = null
   where id = p_id and status = 'running'
   returning * into j;
  if found and j.then_job is not null then
    insert into app.job (workspace_id, queue, type, payload, created_by)
    values (j.workspace_id, j.then_job ->> 'queue', j.then_job ->> 'type',
            coalesce(j.then_job -> 'payload', '{}') || jsonb_build_object('previousJobId', j.id, 'previousResult', p_result),
            j.created_by);
  end if;
end $$;

-- Failure: retry with exponential backoff (30 s, 2 min, 8 min, …) unless attempts are exhausted or the error
-- is permanent.
create function app.fail_job(p_id uuid, p_error text, p_permanent boolean default false) returns void
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  update app.job
     set status = case when p_permanent or attempts >= max_attempts then 'failed' else 'queued' end,
         run_after = now() + (interval '30 seconds' * power(4, greatest(attempts - 1, 0))),
         error = left(p_error, 2000),
         finished_at = case when p_permanent or attempts >= max_attempts then now() end,
         locked_by = null, locked_at = null, updated_at = now()
   where id = p_id and status = 'running';
end $$;

create function app.job_progress(p_id uuid, p_progress integer) returns void
  language sql volatile security definer set search_path = app, pg_temp as $$
  update app.job set progress = least(greatest(p_progress, 0), 99), updated_at = now() where id = p_id and status = 'running'
$$;

-- Jobs abandoned by a crashed worker go back to the queue.
create function app.requeue_stale_jobs(p_older_than interval default interval '10 minutes') returns integer
  language sql volatile security definer set search_path = app, pg_temp as $$
  with stale as (
    update app.job set status = 'queued', locked_by = null, locked_at = null, updated_at = now()
     where status = 'running' and locked_at < now() - p_older_than returning 1)
  select count(*)::integer from stale
$$;

-- ---------------------------------------------------------------------------------------------
-- Imports (IMP-01..10, UP-01)
-- ---------------------------------------------------------------------------------------------
create table app.import_profile (
  workspace_id       uuid not null references app.workspace (id) on delete cascade,
  id                 uuid not null default gen_random_uuid(),
  name               text not null,
  institution        text,
  fingerprint        text not null,
  mapping            jsonb not null,
  ledger_account_id  uuid,
  use_count          integer not null default 0,
  last_used_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, id)
);
create unique index import_profile_fingerprint
  on app.import_profile (workspace_id, fingerprint, coalesce(ledger_account_id, '00000000-0000-0000-0000-000000000000'));

create table app.import_batch (
  workspace_id               uuid not null references app.workspace (id) on delete cascade,
  id                         uuid not null default gen_random_uuid(),
  entity_id                  uuid not null,            -- entity of the target account (RLS)
  ledger_account_id          uuid not null,
  file_id                    uuid not null,
  file_name                  text not null,
  file_type                  text not null check (file_type in ('csv', 'xlsx', 'xls', 'pdf')),
  profile_id                 uuid,
  fingerprint                text,
  mapping                    jsonb,
  mapping_source             text check (mapping_source in ('profile', 'reference', 'heuristic', 'user')),
  mapping_confidence         numeric(4, 3),
  status                     text not null default 'uploaded'
                               check (status in ('uploaded', 'parsing', 'needs_mapping', 'preview', 'committing', 'committed', 'failed', 'undone')),
  currency                   char(3) not null,
  rows_read                  integer not null default 0,
  rows_added                 integer not null default 0,
  rows_matched               integer not null default 0,
  rows_skipped               integer not null default 0,
  rows_failed                integer not null default 0,
  min_date                   date,
  max_date                   date,
  statement_opening_minor    bigint,
  statement_closing_minor    bigint,
  balance_check              text not null default 'n_a' check (balance_check in ('ok', 'mismatch', 'n_a')),
  balance_gap_minor          bigint,
  warnings                   jsonb not null default '[]',
  error                      text,
  committed_at               timestamptz,
  undo_until                 timestamptz,
  undone_at                  timestamptz,
  created_by                 uuid references app.app_user (id),
  version                    bigint not null default 1,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id, ledger_account_id) references app.ledger_account (workspace_id, entity_id, id),
  foreign key (workspace_id, file_id) references app.file (workspace_id, id),
  foreign key (workspace_id, profile_id) references app.import_profile (workspace_id, id) on delete set null
);
create index import_batch_account on app.import_batch (workspace_id, ledger_account_id, created_at desc);

create table app.import_row (
  workspace_id                 uuid not null,
  id                           uuid not null default gen_random_uuid(),
  import_batch_id              uuid not null,
  row_no                       integer not null,
  raw                          jsonb not null,
  txn_date                     date,
  amount_minor                 bigint,
  description                  text,
  payee_raw                    text,
  normalized_desc              text,
  balance_minor                bigint,
  ordinal                      integer not null default 0,
  dedupe_key                   text,
  -- Classification from the pipeline (design 04 §3.5) …
  status                       text not null check (status in ('new', 'duplicate', 'probable_duplicate', 'match', 'error')),
  -- … and the user's decision in the preview (IMP-06); null = follow the classification.
  decision                     text check (decision in ('import', 'skip', 'match')),
  match_transaction_id         uuid,
  duplicate_of_transaction_id  uuid,
  score                        numeric(5, 4),
  suggestion                   jsonb,
  category_id                  uuid,
  error                        text,
  outcome                      text check (outcome in ('added', 'matched', 'skipped', 'failed')),
  transaction_id               uuid,
  created_at                   timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, import_batch_id, row_no),
  foreign key (workspace_id, import_batch_id) references app.import_batch (workspace_id, id) on delete cascade
);
create index import_row_batch on app.import_row (workspace_id, import_batch_id, row_no);

-- One row per import row that created, confirmed or joined a transaction (design 03 §4.1, 04 §3).
create table app.transaction_source (
  workspace_id       uuid not null,
  transaction_id     uuid not null,
  import_row_id      uuid not null,
  import_batch_id    uuid not null,
  ledger_account_id  uuid not null,
  role               text not null check (role in ('created', 'matched', 'second_leg')),
  before_image       jsonb,
  created_at         timestamptz not null default now(),
  primary key (workspace_id, transaction_id, import_row_id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete cascade,
  foreign key (workspace_id, import_row_id) references app.import_row (workspace_id, id) on delete cascade
);
create index transaction_source_batch on app.transaction_source (workspace_id, import_batch_id);

alter table app.transaction add column statement_date date;
alter table app.transaction add column raw_description text;

-- Raw text → payee (IMP-10). The raw text is always kept on the transaction.
create table app.payee_alias (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  pattern       text not null,
  payee_id      uuid not null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, pattern),
  foreign key (workspace_id, payee_id) references app.payee (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Reconciliation (DE-08)
-- ---------------------------------------------------------------------------------------------
create table app.reconciliation (
  workspace_id             uuid not null,
  id                       uuid not null default gen_random_uuid(),
  entity_id                uuid not null,
  ledger_account_id        uuid not null,
  statement_date           date not null,
  statement_balance_minor  bigint not null,
  status                   text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  completed_at             timestamptz,
  completed_by             uuid references app.app_user (id),
  created_by               uuid references app.app_user (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id, ledger_account_id) references app.ledger_account (workspace_id, entity_id, id)
);
create unique index reconciliation_one_open on app.reconciliation (workspace_id, ledger_account_id) where status = 'in_progress';

-- ---------------------------------------------------------------------------------------------
-- Reference data (OPS-05): shared, versioned, read-only for the app; updated without an app release.
-- ---------------------------------------------------------------------------------------------
create schema ref;
grant usage on schema ref to montra_app;

create table ref.import_profile (
  id           text primary key,
  name         text not null,
  institution  text,
  source       text not null check (source in ('bank', 'app_template')),
  fingerprint  text not null unique,
  mapping      jsonb not null,
  version      integer not null default 1,
  updated_at   timestamptz not null default now()
);

create table ref.merchant (
  id            text primary key,
  display_name  text not null,
  match_key     text not null unique,   -- normalized description prefix, e.g. 'BLUE BOTTLE'
  mcc           text,
  category_hint text,                   -- e.g. 'Dining out'
  version       integer not null default 1,
  updated_at    timestamptz not null default now()
);
create index merchant_key_trgm on ref.merchant using gin (match_key gin_trgm_ops);

grant select on all tables in schema ref to montra_app;

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants
-- ---------------------------------------------------------------------------------------------
create trigger import_batch_touch before update on app.import_batch for each row execute function app.touch_versioned();
create trigger import_profile_touch before update on app.import_profile for each row execute function app.touch();
create trigger reconciliation_touch before update on app.reconciliation for each row execute function app.touch();
create trigger import_batch_change after insert or update or delete on app.import_batch for each row execute function app.record_change();
create trigger reconciliation_change after insert or update or delete on app.reconciliation for each row execute function app.record_change();
create trigger import_batch_audit after insert or update or delete on app.import_batch for each row execute function app.audit_row();
create trigger reconciliation_audit after insert or update or delete on app.reconciliation for each row execute function app.audit_row();

do $$
declare t text;
begin
  foreach t in array array['file', 'job', 'import_profile', 'import_batch', 'import_row', 'transaction_source', 'payee_alias', 'reconciliation'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
end $$;

create policy file_all on app.file for all
  using (workspace_id = app.current_workspace_id() and app.is_member())
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner', 'accountant'));

-- Members see their workspace's jobs; workers go through the definer functions above.
create policy job_select on app.job for select using (workspace_id = app.current_workspace_id() and app.is_member());
create policy job_insert on app.job for insert with check (workspace_id = app.current_workspace_id() and app.is_member());

create policy import_profile_all on app.import_profile for all
  using (workspace_id = app.current_workspace_id() and app.is_member())
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner', 'accountant'));

create policy import_batch_select on app.import_batch for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy import_batch_write on app.import_batch for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

create policy import_row_all on app.import_row for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.import_batch b where b.workspace_id = import_row.workspace_id and b.id = import_row.import_batch_id))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.import_batch b where b.workspace_id = import_row.workspace_id and b.id = import_row.import_batch_id));

create policy transaction_source_all on app.transaction_source for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = transaction_source.workspace_id and t.id = transaction_source.transaction_id))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = transaction_source.workspace_id and t.id = transaction_source.transaction_id));

create policy payee_alias_all on app.payee_alias for all
  using (workspace_id = app.current_workspace_id() and app.is_member())
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner'));

create policy reconciliation_select on app.reconciliation for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy reconciliation_write on app.reconciliation for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

alter table app.posting
  add foreign key (workspace_id, reconciliation_id) references app.reconciliation (workspace_id, id);

grant select, insert, update, delete on app.file, app.import_profile, app.import_batch, app.import_row,
  app.transaction_source, app.payee_alias, app.reconciliation to montra_app;
grant select, insert on app.job to montra_app;
grant execute on function app.dequeue_job(text, text), app.complete_job(uuid, jsonb), app.fail_job(uuid, text, boolean),
  app.job_progress(uuid, integer), app.requeue_stale_jobs(interval) to montra_app;
