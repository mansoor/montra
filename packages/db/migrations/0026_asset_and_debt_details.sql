-- The last of the per-type details (ADR-0027): what a home or car cost and the loan against it, and when an informal debt
-- is due. Savings interest and cash counts need nothing new.
alter table app.bank_account
  add column purchase_price_minor bigint check (purchase_price_minor is null or purchase_price_minor >= 0),
  add column purchase_date        date,
  add column loan_account_id      uuid,   -- an asset's loan: equity is its value less what's owed on this
  add column due_date             date,   -- when money owed outside a bank is due
  add foreign key (workspace_id, loan_account_id) references app.ledger_account (workspace_id, id);
