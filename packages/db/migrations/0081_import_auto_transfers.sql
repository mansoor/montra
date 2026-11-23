-- Import makes sure transfer pairs into transfers (TXN-04, AI-03; ADR-0028 amendment of 2026-11-23). Until now a pair
-- that step 3 was sure of (0.95: the same amount, opposite sign, on another account within 3 days, with a payment or
-- transfer word) waited in Review like any other. Now an import commit makes it a transfer on its own when its confidence
-- reaches the workspace's setting (`ai_settings.transferThreshold`, default 0.95; null turns it off), the same way
-- accepting it in Review does: the other side is absorbed and its statement line moves to the transfer.
--
-- 1. `import_batch.rows_transferred`: how many of the batch's rows it made transfers, for the import summary.
-- 2. `transfer_conversion`: what making a transfer changed, so it can be undone exactly. One row per transfer made from
--    a plain transaction (by an import, by Review or by hand). Undoing the transfer, or the import that made it, puts the
--    transaction back as it was and brings the absorbed side back out of the trash with its statement lines.

alter table app.import_batch add column rows_transferred integer not null default 0;

create table app.transfer_conversion (
  workspace_id     uuid not null,
  -- The transfer: the plain transaction that was rewritten in place.
  transaction_id   uuid not null,
  -- The other side that was absorbed (voided into the trash), if there was one.
  absorbed_id      uuid,
  -- The import whose commit made it; null when it was made in Review or by hand. No foreign key, as for
  -- `transaction_source.import_batch_id`.
  import_batch_id  uuid,
  -- What undo puts back: the transaction's spec, categorization, review state and cleared state; the absorbed side's
  -- review state, cleared state and statement lines (`transaction_source` rows with their roles and before images);
  -- and the transfer as it was made, so a transfer changed since isn't undone over the change.
  before           jsonb not null,
  created_at       timestamptz not null default now(),
  primary key (workspace_id, transaction_id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete cascade,
  foreign key (workspace_id, absorbed_id) references app.transaction (workspace_id, id) on delete cascade
);
create index transfer_conversion_batch on app.transfer_conversion (workspace_id, import_batch_id)
  where import_batch_id is not null;
create index transfer_conversion_absorbed on app.transfer_conversion (workspace_id, absorbed_id)
  where absorbed_id is not null;

alter table app.transfer_conversion enable row level security;
alter table app.transfer_conversion force row level security;

-- Like `transaction_source`: visible and writable with the transaction it belongs to.
create policy transfer_conversion_all on app.transfer_conversion for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = transfer_conversion.workspace_id
                     and t.id = transfer_conversion.transaction_id))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = transfer_conversion.workspace_id
                     and t.id = transfer_conversion.transaction_id));

grant select, insert, update, delete on app.transfer_conversion to montra_app;
