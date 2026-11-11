-- Switching from another app (IMP-13, ADR-0029): one export, several accounts. A migration groups the import batches
-- made from one app's export (one batch per account, the existing statement pipeline) and keeps the user's plan: how the
-- file's category names map to Montra categories, so each batch's rows land in them.

create table app.import_migration (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null,
  -- The app the export came from (ynab, monarch, …, other); display only.
  source        text not null check (length(source) between 1 and 40),
  -- { categories: { "<file category, lower case>": "<category id>" }, accounts: [...] } as confirmed by the user.
  plan          jsonb not null default '{}'::jsonb,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, id)
);

alter table app.import_batch add column migration_id uuid;
alter table app.import_batch
  add constraint import_batch_migration foreign key (workspace_id, migration_id)
  references app.import_migration (workspace_id, id) on delete set null (migration_id);
create index import_batch_migration_idx on app.import_batch (workspace_id, migration_id) where migration_id is not null;

alter table app.import_migration enable row level security;
alter table app.import_migration force row level security;
create policy import_migration_all on app.import_migration for all
  using (workspace_id = app.current_workspace_id() and app.is_member())
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner', 'accountant'));
grant select, insert, update, delete on app.import_migration to montra_app;
