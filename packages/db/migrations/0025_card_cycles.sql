-- Credit cards and lines of credit: when the payment is due, and how it's paid (ADR-0026). The statement day has been on
-- the account since 0001.
alter table app.bank_account
  add column due_day             smallint check (due_day between 1 and 31),
  add column pay_from_account_id uuid,                      -- the forecast takes the payment from here
  add column pay_rule            text check (pay_rule in ('statement', 'minimum', 'fixed')),
  add column pay_fixed_minor     bigint check (pay_fixed_minor is null or pay_fixed_minor > 0),
  add foreign key (workspace_id, pay_from_account_id) references app.ledger_account (workspace_id, id),
  add constraint bank_account_pay_rule_from check (pay_rule is null or pay_from_account_id is not null),
  add constraint bank_account_pay_fixed check ((pay_rule = 'fixed') = (pay_fixed_minor is not null));
