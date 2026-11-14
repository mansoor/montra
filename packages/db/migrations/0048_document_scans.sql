-- Scanned documents read before they're filed (ADR-0048 §3): a statement, payslip or bill scanned from the Add wheel is
-- read once, and the reading suggests where it goes: the account a statement is for, the employer and person on a
-- payslip, the biller on a bill. The person confirms, and the import, payslip or bill is made from the same reading, so
-- the document isn't read twice.
--
-- A scan is its uploader's own until it's used, like a saved report. The reading is cleared once the scan is used.

create table app.document_scan (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  user_id       uuid not null references app.app_user (id),
  kind          text not null check (kind in ('statement', 'payslip', 'bill')),
  file_ids      uuid[] not null check (cardinality(file_ids) between 1 and 20),
  status        text not null default 'reading' check (status in ('reading', 'ready', 'failed', 'used')),
  -- The reading: the doc-worker's result for a statement, the AI's extraction for a payslip or bill.
  result        jsonb,
  -- What the reading points at: candidates with reasons, and the one picked when it's clear.
  detected      jsonb,
  error         text,
  -- The import, payslip or bill made from it.
  used_id       uuid,
  job_id        uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id)
);

create index document_scan_user on app.document_scan (workspace_id, user_id, created_at desc);

alter table app.document_scan enable row level security;
alter table app.document_scan force row level security;

create policy document_scan_own on app.document_scan for all
  using (workspace_id = app.current_workspace_id() and user_id = app.current_user_id())
  with check (workspace_id = app.current_workspace_id() and user_id = app.current_user_id());

grant select, insert, update, delete on app.document_scan to montra_app;
