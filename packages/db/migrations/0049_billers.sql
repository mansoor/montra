-- Billers (ADR-0048 §4): the providers that send the bills a budget category pays, named by the owner on the budget:
-- "SDG&E" on Utilities, "GEICO" on Auto insurance. A biller belongs to its category, and so to its books (entity).
-- Budget lines are made again each period; a biller stays.
--
-- Each active biller's next bill comes into upcoming, the calendar, bill-due alerts and the forecast: estimated from
-- its recent payments until a scanned bill gives the exact amount and date. `match_key` is the name normalized like a
-- payee (`normalizeDescription`), for finding its payments and, later, its scanned bills.

create table app.biller (
  workspace_id   uuid not null references app.workspace (id) on delete cascade,
  id             uuid not null default gen_random_uuid(),
  entity_id      uuid not null,
  category_id    uuid not null,
  name           text not null check (length(name) between 1 and 200),
  match_key      text not null check (length(match_key) between 1 and 200),
  -- Who it's for, when it's one person's (their phone, their car insurance).
  member_id      uuid,
  -- The account number at the biller: only its last four digits, for matching scanned bills.
  account_last4  text check (account_last4 ~ '^[0-9]{4}$'),
  -- The usual day the bill is due; otherwise the day it's usually paid.
  due_day        smallint check (due_day between 1 and 31),
  cadence        text not null default 'monthly'
                   check (cadence in ('monthly', 'bimonthly', 'quarterly', 'semiannual', 'yearly')),
  archived_at    timestamptz,
  created_by     uuid references app.app_user (id),
  version        bigint not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, category_id) references app.ledger_account (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id) on delete set null (member_id)
);

-- One active biller of a name per books.
create unique index biller_name on app.biller (workspace_id, entity_id, lower(name)) where archived_at is null;
create index biller_category on app.biller (workspace_id, category_id) where archived_at is null;

create trigger biller_touch before update on app.biller for each row execute function app.touch_versioned();
create trigger biller_audit after insert or update or delete on app.biller for each row execute function app.audit_row();

alter table app.biller enable row level security;
alter table app.biller force row level security;

-- Like the other planning rows: read with the books, written by members who can write to them.
create policy biller_select on app.biller for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy biller_write on app.biller for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

grant select, insert, update, delete on app.biller to montra_app;
