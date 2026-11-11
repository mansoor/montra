-- A business's logo and domain (BIZ-01, BIZ-05; ADR-0032), and moving an account to other books (ACC-03; ADR-0033).

-- ---------------------------------------------------------------------------------------------
-- Logo and domain. The logo is a PNG or JPEG in object storage (checked by its content, like receipts), shown in the
-- settings and printed on invoices. The domain is the business's website or email domain, stored as a bare host name
-- ("example.com"); the API normalizes and validates it.
-- ---------------------------------------------------------------------------------------------
alter table app.business_profile add column logo_file_id uuid;
alter table app.business_profile
  add constraint business_profile_logo foreign key (workspace_id, logo_file_id) references app.file (workspace_id, id);
alter table app.business_profile add column domain text
  check (domain is null or (length(domain) between 3 and 253 and domain = lower(domain) and domain !~ '[\s/@:]'));

-- Logos are their own kind of file: not paperwork, so they aren't kept for seven years once replaced.
alter table app.file drop constraint file_kind_check;
alter table app.file add constraint file_kind_check
  check (kind in ('statement', 'receipt', 'payslip', 'lease', 'invoice', 'export', 'other', 'logo'));

-- ---------------------------------------------------------------------------------------------
-- ADR-0033: an account moved from one entity's books to another's. Its history is re-posted into the new books in the
-- same transaction; this row says when, by whom and how much moved, so the register can say where it came from.
-- ---------------------------------------------------------------------------------------------
create table app.account_move (
  workspace_id       uuid not null references app.workspace (id) on delete cascade,
  id                 uuid not null default gen_random_uuid(),
  ledger_account_id  uuid not null,
  from_entity_id     uuid not null,
  to_entity_id       uuid not null,
  transactions       integer not null check (transactions >= 0),
  entries            integer not null check (entries >= 0),
  moved_by           uuid references app.app_user (id),
  moved_at           timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, ledger_account_id) references app.ledger_account (workspace_id, id) on delete cascade,
  foreign key (workspace_id, from_entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, to_entity_id) references app.entity (workspace_id, id) on delete cascade,
  check (from_entity_id <> to_entity_id)
);
create index account_move_account on app.account_move (workspace_id, ledger_account_id, moved_at desc);

alter table app.account_move enable row level security;
alter table app.account_move force row level security;
-- Whoever can see the account now can see where it came from; only someone who can write both books moves it.
create policy account_move_select on app.account_move for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(to_entity_id));
create policy account_move_insert on app.account_move for insert
  with check (workspace_id = app.current_workspace_id()
              and app.can_write_entity(from_entity_id) and app.can_write_entity(to_entity_id));
grant select, insert on app.account_move to montra_app;
