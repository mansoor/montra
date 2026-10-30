-- 0007_import_analysis: keep the mapping analysis (header, sample rows, accounts found) for the mapping UI,
-- and the latest job so a failed extraction surfaces on the batch.
alter table app.import_batch add column analysis jsonb;
alter table app.import_batch add column job_id uuid references app.job (id) on delete set null;
