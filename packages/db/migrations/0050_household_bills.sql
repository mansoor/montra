-- Household bills (ADR-0048 §4): a bill from a biller on personal books, usually scanned from the Add wheel. It has
-- the exact amount and due date, so it replaces the biller's estimate in upcoming, the calendar, bill-due alerts and
-- the forecast until it's paid. A payment to the biller near the due date for the amount marks it paid.
--
-- A biller on a business's books files its bills as that business's vendor bills (app.bill, ADR-0017) instead.

create table app.household_bill (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  id              uuid not null default gen_random_uuid(),
  entity_id       uuid not null,
  biller_id       uuid not null,
  member_id       uuid,
  status          text not null default 'open' check (status in ('open', 'paid', 'void')),
  amount_minor    bigint not null check (amount_minor > 0),
  currency        char(3) not null,
  due_date        date not null,
  bill_date       date,
  period_start    date,
  period_end      date,
  attachment_ids  uuid[] not null default '{}',
  -- The payment that settled it.
  transaction_id  uuid,
  paid_at         timestamptz,
  -- { provider, model, confidence, warnings[] } when it was read from a scan.
  extraction      jsonb,
  created_by      uuid references app.app_user (id),
  version         bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, biller_id) references app.biller (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id) on delete set null (member_id),
  check (period_start is null or period_end is null or period_start <= period_end),
  check ((status = 'paid') = (paid_at is not null))
);

create index household_bill_open on app.household_bill (workspace_id, biller_id, due_date) where status = 'open';
create unique index household_bill_payment on app.household_bill (workspace_id, transaction_id)
  where transaction_id is not null;

create trigger household_bill_touch before update on app.household_bill
  for each row execute function app.touch_versioned();
create trigger household_bill_audit after insert or update or delete on app.household_bill
  for each row execute function app.audit_row();

alter table app.household_bill enable row level security;
alter table app.household_bill force row level security;

create policy household_bill_select on app.household_bill for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy household_bill_write on app.household_bill for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

grant select, insert, update, delete on app.household_bill to montra_app;
