-- Remembering a transfer the person made by hand (TXN-04, AI-05; ADR-0028 "Making a transfer by hand"). Statement lines
-- such as "CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224" or "USBANK LOAN" pay a card or a loan but carry the payee's ID,
-- not the card's last 4, so pairing doesn't find them. When the person makes one a transfer to an account, the payee
-- is remembered with that account, and the next line from the same payee is suggested as a transfer there. It is only
-- a suggestion: review's "Make transfer" applies it, as with any detected transfer.
--
-- Beside `payee_history`, which holds categories: a transfer's other account is a bank, card or loan account, and
-- history's suggestions are applied as a category.

create table app.payee_transfer (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  payee_key     text not null,
  account_id    uuid not null,
  count         integer not null default 1 check (count >= 0),
  last_used_at  timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, account_id) references app.ledger_account (workspace_id, id) on delete cascade
);
create unique index payee_transfer_key on app.payee_transfer (workspace_id, payee_key, account_id);

alter table app.payee_transfer enable row level security;
alter table app.payee_transfer force row level security;

-- Like payee history, it follows the account's entity: no one learns from, or sees, books they can't read.
create policy payee_transfer_all on app.payee_transfer for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account a where a.workspace_id = payee_transfer.workspace_id
                     and a.id = payee_transfer.account_id and app.can_read_entity(a.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account a where a.workspace_id = payee_transfer.workspace_id
                     and a.id = payee_transfer.account_id and app.can_write_entity(a.entity_id)));

grant select, insert, update, delete on app.payee_transfer to montra_app;
