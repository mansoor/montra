-- Retirement and investment accounts, their market value, and employer contributions (ADR-0025).

-- What kind of plan an investment account is, and the employer whose payslips pay into it.
alter table app.bank_account
  add column plan_type text check (plan_type in ('brokerage', '401k', 'roth_401k', '403b', 'ira', 'roth_ira', 'hsa',
                                                 '529', 'pension', 'other')),
  add column employer_id uuid,
  add column employer_contributions boolean not null default false,  -- the employer's match posts here too
  add foreign key (workspace_id, employer_id) references app.employer (workspace_id, id) on delete set null (employer_id);

-- What a payslip posted for the employer, so budgets can keep it out of take-home pay.
alter table app.payslip
  add column employer_posted_minor bigint not null default 0 check (employer_posted_minor >= 0);

-- A change in market value is its own kind of entry, against its own equity account: it moves net worth, not income.
-- contract: widens the allowed kinds; every existing value stays allowed.
alter table app.journal_entry drop constraint journal_entry_kind_check;
alter table app.journal_entry add constraint journal_entry_kind_check
  check (kind in ('standard', 'transfer', 'opening_balance', 'adjustment', 'reversal', 'depreciation', 'fx_revaluation',
                  'closing', 'manual', 'valuation'));

-- contract: widens the allowed roles; every existing value stays allowed.
alter table app.ledger_account drop constraint ledger_account_system_role_check;
alter table app.ledger_account add constraint ledger_account_system_role_check
  check (system_role in ('opening_balance_equity', 'uncategorized_income', 'uncategorized_expense', 'owner_contribution',
                         'owner_draw', 'inter_entity_clearing', 'due_to_entity', 'due_from_entity', 'fx_gain_loss',
                         'fx_rounding', 'security_deposits_held', 'bank_fees', 'sales_tax_payable',
                         'investment_gains'));

insert into app.ledger_account (workspace_id, entity_id, type, subtype, name, currency, system_role)
select e.workspace_id, e.id, 'equity', 'system', 'Investment gains and losses', e.functional_currency, 'investment_gains'
  from app.entity e
 where not exists (select 1 from app.ledger_account a
                    where a.workspace_id = e.workspace_id and a.entity_id = e.id and a.system_role = 'investment_gains');

-- Each value someone gave an account, from a statement or by hand. Its entry posts the difference from what the ledger had.
create table app.account_valuation (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  entity_id     uuid not null,
  account_id    uuid not null,
  value_date    date not null,
  value_minor   bigint not null check (value_minor >= 0),
  change_minor  bigint not null,
  entry_id      uuid,                                        -- null when the value was already right
  note          text check (note is null or length(note) <= 500),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id) references app.ledger_account (workspace_id, id),
  foreign key (workspace_id, entry_id) references app.journal_entry (workspace_id, id)
);
create index account_valuation_account on app.account_valuation (workspace_id, account_id, value_date);

create trigger account_valuation_audit after insert or update or delete on app.account_valuation
  for each row execute function app.audit_row();
alter table app.account_valuation enable row level security;
alter table app.account_valuation force row level security;
create policy account_valuation_select on app.account_valuation for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy account_valuation_write on app.account_valuation for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));
grant select, insert, update, delete on app.account_valuation to montra_app;

-- Whether an account has postings this user can't read (a partner's view of a member's payslip savings). A value or a
-- gain worked out from what they can see would be wrong. Definer: the posting policy hides exactly what's asked about.
create function app.account_has_hidden_postings(p_workspace uuid, p_account uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.posting p
                  where p.workspace_id = p_workspace and p.ledger_account_id = p_account
                    and p.restricted and not app.can_read_restricted(p.restricted_member_id))
$$;
revoke all on function app.account_has_hidden_postings(uuid, uuid) from public;
grant execute on function app.account_has_hidden_postings(uuid, uuid) to montra_app;
