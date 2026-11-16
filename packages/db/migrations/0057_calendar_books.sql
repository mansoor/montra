-- The calendar by book (FLOW-05, UP-14), as Google Calendar's calendars: each book has a colour, and each person picks
-- which books their calendar shows, the same on the web and the phone.

-- -----------------------------------------------------------------------------
-- A book's colour. Null until someone picks one: the clients then choose one from a small palette by the book's id
-- (`bookColors` in @montra/domain), so the web and the phone agree.
-- -----------------------------------------------------------------------------
alter table app.entity add column color text check (color ~ '^#[0-9a-fA-F]{6}$');

-- -----------------------------------------------------------------------------
-- Which books a person's calendar hides, per workspace. Not a security boundary: RLS on the books still decides what
-- anyone sees. A hidden book the person can no longer see, or that was archived, is ignored when read.
-- -----------------------------------------------------------------------------
create table app.calendar_book_pref (
  workspace_id       uuid not null,
  user_id            uuid not null,
  hidden_entity_ids  uuid[] not null default '{}',
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (workspace_id, user_id) references app.workspace_member (workspace_id, user_id) on delete cascade
);

alter table app.calendar_book_pref enable row level security;
alter table app.calendar_book_pref force row level security;
create policy calendar_book_pref_own on app.calendar_book_pref for all
  using (workspace_id = app.current_workspace_id() and user_id = app.current_user_id())
  with check (workspace_id = app.current_workspace_id() and user_id = app.current_user_id() and app.is_member());
grant select, insert, update, delete on app.calendar_book_pref to montra_app;
