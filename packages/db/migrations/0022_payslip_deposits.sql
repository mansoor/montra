-- Splitting pay across accounts (ADR-0022). Fixed amounts go to other accounts, and the rest to the employer's own deposit account. Each
-- is a real deposit on a real statement, so each becomes its own transaction, and can take over its own imported line (PAY-04).

-- The plan, on the employer. A new payslip starts from it.
create table app.employer_deposit (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  employer_id   uuid not null,
  account_id    uuid not null,
  amount_minor  bigint not null check (amount_minor > 0),
  sort_order    integer not null default 0,
  primary key (workspace_id, id),
  unique (workspace_id, employer_id, account_id),
  foreign key (workspace_id, employer_id) references app.employer (workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id) references app.ledger_account (workspace_id, id)
);

-- What this payslip actually does. `transaction_id` and `deposit_spec` work as they do on app.payslip: the transaction it posted to, and
-- the imported deposit's own spec when it took one over, so deleting the payslip gives the plain deposit back.
create table app.payslip_deposit (
  workspace_id    uuid not null,
  id              uuid not null default gen_random_uuid(),
  payslip_id      uuid not null,
  account_id      uuid not null,
  amount_minor    bigint not null check (amount_minor > 0),
  sort_order      integer not null default 0,
  transaction_id  uuid,
  deposit_spec    jsonb,
  primary key (workspace_id, id),
  unique (workspace_id, payslip_id, account_id),
  foreign key (workspace_id, payslip_id) references app.payslip (workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id) references app.ledger_account (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id)
);
create unique index payslip_deposit_transaction on app.payslip_deposit (workspace_id, transaction_id)
  where transaction_id is not null;

alter table app.employer_deposit enable row level security;
alter table app.employer_deposit force row level security;
alter table app.payslip_deposit enable row level security;
alter table app.payslip_deposit force row level security;

-- These follow their employer and payslip, including PAY-09's limits on who can read a payslip.
create policy employer_deposit_select on app.employer_deposit for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.employer e where e.workspace_id = employer_deposit.workspace_id and e.id = employer_deposit.employer_id));
create policy employer_deposit_write on app.employer_deposit for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.employer e where e.workspace_id = employer_deposit.workspace_id and e.id = employer_deposit.employer_id
                     and app.can_write_entity(e.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.employer e where e.workspace_id = employer_deposit.workspace_id and e.id = employer_deposit.employer_id
                     and app.can_write_entity(e.entity_id)));

create policy payslip_deposit_select on app.payslip_deposit for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.payslip p where p.workspace_id = payslip_deposit.workspace_id and p.id = payslip_deposit.payslip_id));
create policy payslip_deposit_write on app.payslip_deposit for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.payslip p where p.workspace_id = payslip_deposit.workspace_id and p.id = payslip_deposit.payslip_id
                     and app.can_write_entity(p.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.payslip p where p.workspace_id = payslip_deposit.workspace_id and p.id = payslip_deposit.payslip_id
                     and app.can_write_entity(p.entity_id)));

grant select, insert, update, delete on app.employer_deposit, app.payslip_deposit to montra_app;
