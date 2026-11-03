-- Phase 5: receipts API additions (RCP-03, RCP-05, RCP-06, RCP-11; ADR-0014).

-- VAT-style receipts print prices that already include the tax: it is reported, not added (RCP-05).
alter table app.receipt add column tax_included boolean not null default false;

-- Item history (RCP-03/06): lines keyed by their normalized printed text, so a category the user chose for
-- "ONN USB-C CHRGR" is found the next time that item is bought.
alter table app.receipt_line add column item_key text;
create index receipt_line_item on app.receipt_line (workspace_id, item_key) where item_key is not null and category_id is not null;

-- Who reviewed a receipt's lines last (the review screen's "Done" marks user choices as history evidence).
alter table app.receipt add column reviewed_at timestamptz;

-- RCP-11: "receipt recommended" flags the user dismissed (per transaction).
create table app.receipt_flag_dismissal (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  transaction_id  uuid not null,
  dismissed_by    uuid references app.app_user (id),
  created_at      timestamptz not null default now(),
  primary key (workspace_id, transaction_id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete cascade
);
alter table app.receipt_flag_dismissal enable row level security;
alter table app.receipt_flag_dismissal force row level security;
create policy receipt_flag_dismissal_all on app.receipt_flag_dismissal for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = receipt_flag_dismissal.workspace_id
                     and t.id = receipt_flag_dismissal.transaction_id))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = receipt_flag_dismissal.workspace_id
                     and t.id = receipt_flag_dismissal.transaction_id));
grant select, insert, update, delete on app.receipt_flag_dismissal to montra_app;
