-- ADR-0057 §5, §6: who holds an account, and its full number.
--
-- ACC-15, holders: the names the bank says own an account, each optionally a family member. Joint accounts list both.
-- They sit beside the default member (who the spending belongs to), which doesn't change. A child table rather than a
-- jsonb list on bank_account, so that:
--   - a linked member is a real foreign key, bound to the account's workspace: a member from another workspace can't be
--     linked, whatever the API does;
--   - each holder's change is its own audit entry and change-feed row;
--   - backups, exports and restores pick the table up from the catalog and remap its ids like any other.
-- How many an account may list is the API's ACCOUNT_MAX_HOLDERS setting, not a constraint here.
--
-- ACC-16, the full number: `bank_account.account_number_enc` (0001) holds it sealed with FieldCrypto (label
-- `bank_account.account_number`), and `bank_account.last4` its last four for "••••1234". Nothing has written the sealed
-- column before now. The audit trigger already redacts every `*_enc` column (0089), and backups already carry it in full
-- and seal it again on restore (the ENCRYPTED catalog), so the only change here is that a kept number always has its
-- last four. NOT VALID: an archive restored before this could in theory have brought a number without them.

alter table app.bank_account
  add constraint bank_account_number_last4 check (account_number_enc is null or last4 is not null) not valid;

create table app.account_holder (
  workspace_id       uuid not null references app.workspace (id) on delete cascade,
  id                 uuid not null default gen_random_uuid(),
  ledger_account_id  uuid not null,
  -- The order the holders are listed in, from 0. The API keeps them dense.
  position           smallint not null check (position >= 0),
  -- As the bank writes it. When a member is linked, the API starts it from the member's name.
  name               text not null check (length(name) between 1 and 100),
  member_id          uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, ledger_account_id, position),
  -- The account, by its ledger account as bank_account itself is (and as a restore of one entity's books follows); the
  -- API only lists holders on bank, card, loan and asset accounts. Deleting the account (ACC-14) takes them with it.
  foreign key (workspace_id, ledger_account_id) references app.ledger_account (workspace_id, id) on delete cascade,
  -- Family members are never deleted (they go inactive), so a link stays valid.
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id)
);
create index account_holder_member on app.account_holder (workspace_id, member_id) where member_id is not null;

alter table app.account_holder enable row level security;
alter table app.account_holder force row level security;

-- It follows the account's books: read with them, changed only by someone who may write them.
create policy account_holder_select on app.account_holder for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account la where la.workspace_id = account_holder.workspace_id
                     and la.id = account_holder.ledger_account_id and app.can_read_entity(la.entity_id)));
create policy account_holder_insert on app.account_holder for insert
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account la where la.workspace_id = account_holder.workspace_id
                     and la.id = account_holder.ledger_account_id and app.can_write_entity(la.entity_id)));
create policy account_holder_update on app.account_holder for update
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account la where la.workspace_id = account_holder.workspace_id
                     and la.id = account_holder.ledger_account_id and app.can_write_entity(la.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account la where la.workspace_id = account_holder.workspace_id
                     and la.id = account_holder.ledger_account_id and app.can_write_entity(la.entity_id)));
create policy account_holder_delete on app.account_holder for delete
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account la where la.workspace_id = account_holder.workspace_id
                     and la.id = account_holder.ledger_account_id and app.can_write_entity(la.entity_id)));

grant select, insert, update, delete on app.account_holder to montra_app;

create trigger account_holder_touch before update on app.account_holder
  for each row execute function app.touch();
create trigger account_holder_audit after insert or update or delete on app.account_holder
  for each row execute function app.audit_row();
-- Phones refresh their accounts when a holder changes (the sync pull watches this table with bank_account).
create trigger account_holder_change after insert or update or delete on app.account_holder
  for each row execute function app.record_change();
