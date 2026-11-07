-- Loans on any account, following the real balance (ADR-0024). A property is now optional, and each payment keeps its
-- parts, so a later rate change or extra payment can't rewrite what was already paid.
alter table app.loan_schedule alter column property_id drop not null;

alter table app.loan_schedule
  add column start_date        date,
  add column paying_account_id uuid,                     -- where the payment comes from; the forecast takes it from here
  add column payment_minor     bigint check (payment_minor is null or payment_minor > 0), -- null: level payment from the terms
  add column payments_before   integer not null default 0 check (payments_before >= 0),   -- already in the balance when tracking began
  add column auto_record       boolean not null default false,
  add foreign key (workspace_id, paying_account_id) references app.ledger_account (workspace_id, id);

alter table app.loan_payment
  add column interest_minor  bigint check (interest_minor >= 0),  -- null: recorded before this migration, so read from the terms
  add column principal_minor bigint check (principal_minor >= 0),
  add column escrow_minor    bigint check (escrow_minor >= 0);
