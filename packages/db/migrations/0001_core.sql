-- 0001_core: tenancy, entities, chart of accounts, transactions and the double-entry ledger.
-- Design: docs/design/03-data-model.md. Runs as montra_owner (BYPASSRLS); the app connects as montra_app.

create schema app;
grant usage on schema app to montra_app;

-- ---------------------------------------------------------------------------------------------
-- Request context. The API sets these with SET LOCAL at the start of every unit of work.
-- ---------------------------------------------------------------------------------------------
create function app.current_workspace_id() returns uuid
  language sql stable as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

create function app.current_user_id() returns uuid
  language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create function app.locked_edit_allowed() returns boolean
  language sql stable as $$ select coalesce(current_setting('app.allow_locked_edit', true), '') = 'on' $$;

create function app.touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function app.touch_versioned() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Identity and tenancy
-- ---------------------------------------------------------------------------------------------
create table app.app_user (
  id                 uuid primary key default gen_random_uuid(),
  identity_id        text unique,
  email              citext not null unique,
  display_name       text not null default '',
  locale             text not null default 'en-US',
  time_zone          text not null default 'UTC',
  date_format        text,
  week_start         smallint not null default 1 check (week_start between 1 and 7),
  email_verified_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create table app.workspace (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(name) between 1 and 200),
  base_currency      char(3) not null,
  time_zone          text not null default 'UTC',
  ai_mode            text not null default 'builtin' check (ai_mode in ('builtin', 'byok', 'local', 'off')),
  ai_settings        jsonb not null default '{}',
  priorities         jsonb not null default '{}',
  inter_entity_mode  text not null default 'equity' check (inter_entity_mode in ('equity', 'due_to_from')),
  plan               text not null default 'free',
  version            bigint not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table app.workspace_member (
  workspace_id   uuid not null references app.workspace (id) on delete cascade,
  user_id        uuid not null references app.app_user (id),
  role           text not null check (role in ('owner', 'partner', 'viewer', 'accountant')),
  status         text not null default 'active' check (status in ('invited', 'active', 'revoked')),
  invited_email  citext,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_member_user on app.workspace_member (user_id);

create table app.entity (
  workspace_id             uuid not null references app.workspace (id) on delete cascade,
  id                       uuid not null default gen_random_uuid() primary key,
  type                     text not null check (type in ('personal', 'business', 'rental')),
  name                     text not null check (length(name) between 1 and 200),
  functional_currency      char(3) not null,
  fiscal_year_start_month  smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  business_type            text check (business_type in ('sole_prop', 'llc', 'single_member_llc', 's_corp', 'partnership', 'other')),
  tax_profile              jsonb not null default '{}',
  archived_at              timestamptz,
  version                  bigint not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index entity_one_personal on app.entity (workspace_id) where type = 'personal';

create table app.entity_grant (
  workspace_id  uuid not null,
  user_id       uuid not null,
  entity_id     uuid not null,
  access        text not null check (access in ('none', 'read', 'write')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, user_id, entity_id),
  foreign key (workspace_id, user_id) references app.workspace_member (workspace_id, user_id) on delete cascade,
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);

create table app.family_member (
  workspace_id    uuid not null references app.workspace (id) on delete cascade,
  id              uuid not null default gen_random_uuid() primary key,
  name            text not null check (length(name) between 1 and 100),
  relationship    text not null check (relationship in ('self', 'spouse_partner', 'child', 'parent', 'other')),
  birth_date      date,
  color           text,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  linked_user_id  uuid references app.app_user (id),
  is_dependent    boolean not null default false,
  version         bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Chart of accounts (DE-02). Bank/card accounts and categories are both ledger accounts.
-- ---------------------------------------------------------------------------------------------
create table app.category_group (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid() primary key,
  entity_id     uuid not null,
  name          text not null,
  kind          text not null check (kind in ('income', 'fixed', 'daily', 'fun', 'savings', 'debt', 'business', 'rental', 'system')),
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);

create table app.ledger_account (
  workspace_id            uuid not null,
  id                      uuid not null default gen_random_uuid() primary key,
  entity_id               uuid not null,
  type                    text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  subtype                 text not null default 'general',
  name                    text not null check (length(name) between 1 and 200),
  parent_id               uuid references app.ledger_account (id),
  currency                char(3) not null,
  is_category             boolean not null default false,
  category_group_id       uuid references app.category_group (id),
  tax_line_code           text,
  system_role             text check (system_role in (
                            'opening_balance_equity', 'uncategorized_income', 'uncategorized_expense',
                            'owner_contribution', 'owner_draw', 'inter_entity_clearing', 'due_to_entity',
                            'due_from_entity', 'fx_gain_loss', 'fx_rounding', 'security_deposits_held', 'bank_fees')),
  counterparty_entity_id  uuid,
  tracks_account_id       uuid references app.ledger_account (id),
  sort_order              integer not null default 0,
  archived_at             timestamptz,
  version                 bigint not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, entity_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, counterparty_entity_id) references app.entity (workspace_id, id),
  check ((system_role in ('inter_entity_clearing', 'due_to_entity', 'due_from_entity')) = (counterparty_entity_id is not null)
         or system_role is null and counterparty_entity_id is null)
);
create unique index ledger_account_system_role
  on app.ledger_account (workspace_id, entity_id, system_role, coalesce(counterparty_entity_id, '00000000-0000-0000-0000-000000000000'))
  where system_role is not null;
create index ledger_account_entity on app.ledger_account (workspace_id, entity_id, type);

create table app.bank_account (
  workspace_id          uuid not null,
  ledger_account_id     uuid not null primary key,
  kind                  text not null check (kind in ('checking', 'savings', 'credit_card', 'cash', 'loan', 'mortgage',
                                                      'line_of_credit', 'investment', 'asset', 'liability')),
  institution           text,
  last4                 text check (last4 ~ '^[0-9]{4}$'),
  account_number_enc    bytea,
  opening_balance_minor bigint not null default 0,
  opening_date          date,
  default_member_id     uuid,
  credit_limit_minor    bigint,
  interest_rate_bps     integer,
  statement_day         smallint check (statement_day between 1 and 31),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (workspace_id, ledger_account_id) references app.ledger_account (workspace_id, id) on delete cascade,
  foreign key (workspace_id, default_member_id) references app.family_member (workspace_id, id)
);

create table app.payee (
  workspace_id         uuid not null references app.workspace (id) on delete cascade,
  id                   uuid not null default gen_random_uuid() primary key,
  display_name         text not null,
  normalized_key       text not null,
  kind                 text not null default 'merchant' check (kind in ('merchant', 'customer', 'vendor', 'employer', 'tenant', 'person')),
  default_category_id  uuid references app.ledger_account (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, normalized_key),
  unique (workspace_id, id)
);
create index payee_name_trgm on app.payee using gin (display_name gin_trgm_ops);

create table app.tag (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  id            uuid not null default gen_random_uuid() primary key,
  name          text not null check (length(name) between 1 and 50),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index tag_name on app.tag (workspace_id, lower(name));

-- ---------------------------------------------------------------------------------------------
-- Transactions and the ledger (DE-01..10). Ledger tables key on (workspace_id, id) for future
-- hash partitioning by workspace.
-- ---------------------------------------------------------------------------------------------
create table app.transaction (
  workspace_id           uuid not null references app.workspace (id) on delete cascade,
  id                     uuid not null default gen_random_uuid(),
  primary_entity_id      uuid not null,
  txn_date               date not null,
  payee_raw              text,
  payee_id               uuid,
  description            text not null default '',
  memo_enc               bytea,
  status                 text not null default 'posted' check (status in ('scheduled', 'pending', 'posted', 'void')),
  review_state           text not null default 'reviewed' check (review_state in ('auto_applied', 'needs_review', 'reviewed')),
  source                 text not null default 'manual' check (source in ('manual', 'camera', 'import', 'receipt', 'payslip', 'recurring', 'system', 'feed')),
  dedupe_key             text,
  original_amount_minor  bigint,
  original_currency      char(3),
  fx_rate                numeric(20, 10),
  recurring_item_id      uuid,
  version                bigint not null default 1,
  created_by             uuid references app.app_user (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, primary_entity_id) references app.entity (workspace_id, id),
  foreign key (workspace_id, payee_id) references app.payee (workspace_id, id)
);
create index transaction_date on app.transaction (workspace_id, txn_date desc, id desc);
create index transaction_dedupe on app.transaction (workspace_id, dedupe_key) where dedupe_key is not null;
create index transaction_review on app.transaction (workspace_id) where review_state = 'needs_review';

create table app.transaction_tag (
  workspace_id    uuid not null,
  transaction_id  uuid not null,
  tag_id          uuid not null,
  primary key (workspace_id, transaction_id, tag_id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete cascade,
  foreign key (workspace_id, tag_id) references app.tag (workspace_id, id) on delete cascade
);

create table app.journal_entry (
  workspace_id          uuid not null,
  id                    uuid not null default gen_random_uuid(),
  entity_id             uuid not null,
  transaction_id        uuid,
  entry_date            date not null,
  description           text not null default '',
  kind                  text not null default 'standard' check (kind in ('standard', 'transfer', 'opening_balance', 'adjustment',
                                                                          'reversal', 'depreciation', 'fx_revaluation', 'closing', 'manual')),
  reverses_entry_id     uuid,
  locked                boolean not null default false,
  restricted            boolean not null default false,
  restricted_member_id  uuid,
  posted_by             uuid references app.app_user (id),
  posted_at             timestamptz not null default now(),
  version               bigint not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id) on delete cascade,
  foreign key (workspace_id, reverses_entry_id) references app.journal_entry (workspace_id, id),
  foreign key (workspace_id, restricted_member_id) references app.family_member (workspace_id, id),
  check (restricted or restricted_member_id is null)
);
create index journal_entry_date on app.journal_entry (workspace_id, entity_id, entry_date);
create index journal_entry_transaction on app.journal_entry (workspace_id, transaction_id);

create table app.posting (
  workspace_id             uuid not null,
  id                       uuid not null default gen_random_uuid(),
  journal_entry_id         uuid not null,
  entity_id                uuid not null,          -- copied from journal_entry by trigger
  entry_date               date not null,          -- copied from journal_entry by trigger
  restricted               boolean not null default false, -- copied from journal_entry by trigger
  line_no                  integer not null check (line_no > 0),
  ledger_account_id        uuid not null,
  amount_minor             bigint not null,        -- account currency, debit positive
  currency                 char(3) not null,
  functional_amount_minor  bigint not null,        -- entity functional currency, debit positive
  fx_rate                  numeric(20, 10),
  member_id                uuid,                   -- null = Household (FAM-03)
  property_id              uuid,
  unit_id                  uuid,
  memo                     text,
  cleared                  text not null default 'uncleared' check (cleared in ('uncleared', 'cleared', 'reconciled')),
  reconciliation_id        uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, journal_entry_id, line_no),
  foreign key (workspace_id, journal_entry_id) references app.journal_entry (workspace_id, id) on delete cascade,
  foreign key (workspace_id, entity_id, ledger_account_id) references app.ledger_account (workspace_id, entity_id, id),
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id),
  check (amount_minor <> 0 or functional_amount_minor <> 0)
);
create index posting_account_date on app.posting (workspace_id, ledger_account_id, entry_date);
create index posting_entity_date on app.posting (workspace_id, entity_id, entry_date);

create table app.period_lock (
  workspace_id    uuid not null,
  entity_id       uuid not null,
  locked_through  date not null,
  locked_by       uuid references app.app_user (id),
  locked_at       timestamptz not null default now(),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, entity_id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade
);

create table app.period_lock_event (
  workspace_id    uuid not null,
  id              bigint generated always as identity,
  entity_id       uuid not null,
  action          text not null check (action in ('lock', 'unlock', 'relock')),
  locked_through  date,
  actor_user_id   uuid,
  note            text,
  at              timestamptz not null default now(),
  primary key (workspace_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Platform tables: audit log, change feed, idempotency keys
-- ---------------------------------------------------------------------------------------------
create table app.audit_log (
  workspace_id   uuid not null,
  id             bigint generated always as identity,
  actor_user_id  uuid,
  actor_type     text not null default 'user' check (actor_type in ('user', 'system', 'support', 'worker')),
  action         text not null,
  subject_type   text not null,
  subject_id     text,
  diff           jsonb,
  at             timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index audit_log_subject on app.audit_log (workspace_id, subject_type, subject_id);

create table app.workspace_seq (
  workspace_id  uuid primary key references app.workspace (id) on delete cascade,
  seq           bigint not null default 0
);

create table app.change_log (
  workspace_id  uuid not null,
  seq           bigint not null,
  table_name    text not null,
  row_id        text not null,
  op            text not null check (op in ('insert', 'update', 'delete')),
  entity_id     uuid,
  restricted    boolean not null default false,
  changed_at    timestamptz not null default now(),
  primary key (workspace_id, seq)
);

create table app.idempotency_key (
  workspace_id   uuid not null references app.workspace (id) on delete cascade,
  key            text not null check (length(key) between 8 and 200),
  request_hash   text not null,
  status_code    integer not null,
  response       jsonb,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '24 hours',
  primary key (workspace_id, key)
);

-- ---------------------------------------------------------------------------------------------
-- Ledger invariants
-- ---------------------------------------------------------------------------------------------

-- Postings inherit entity, date and restriction from their entry.
create function app.posting_inherit_entry() returns trigger language plpgsql as $$
declare je record;
begin
  select entity_id, entry_date, restricted into je
    from app.journal_entry where workspace_id = new.workspace_id and id = new.journal_entry_id;
  if not found then
    raise exception 'journal entry % not found', new.journal_entry_id using errcode = 'foreign_key_violation';
  end if;
  new.entity_id := je.entity_id;
  new.entry_date := je.entry_date;
  new.restricted := je.restricted;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;
create trigger posting_inherit_entry before insert or update on app.posting
  for each row execute function app.posting_inherit_entry();

create function app.journal_entry_propagate() returns trigger language plpgsql as $$
begin
  if new.entity_id is distinct from old.entity_id then
    raise exception 'a journal entry cannot move to another entity' using errcode = 'check_violation';
  end if;
  if new.entry_date is distinct from old.entry_date or new.restricted is distinct from old.restricted then
    update app.posting set entry_date = new.entry_date, restricted = new.restricted
     where workspace_id = new.workspace_id and journal_entry_id = new.id;
  end if;
  return null;
end $$;
create trigger journal_entry_propagate after update on app.journal_entry
  for each row execute function app.journal_entry_propagate();

-- DE-01 / CUR-07: at least two postings, functional amounts sum to zero, currency matches account.
-- Runs at commit (deferred) so an entry and its postings can be written in any order.
create function app.assert_entry_balanced(p_workspace uuid, p_entry uuid) returns void
  language plpgsql security definer set search_path = app, pg_temp as $$
declare n integer; total numeric; bad integer; func_ccy char(3);
begin
  select e.functional_currency into func_ccy
    from app.journal_entry je join app.entity e on e.id = je.entity_id
   where je.workspace_id = p_workspace and je.id = p_entry;
  if not found then return; end if; -- entry deleted in this transaction
  select count(*), coalesce(sum(functional_amount_minor), 0) into n, total
    from app.posting where workspace_id = p_workspace and journal_entry_id = p_entry;
  if n < 2 then
    raise exception 'journal entry % has % posting(s); at least 2 are required', p_entry, n
      using errcode = 'check_violation', hint = 'ledger.too_few_postings';
  end if;
  if total <> 0 then
    raise exception 'journal entry % is unbalanced by % minor units', p_entry, total
      using errcode = 'check_violation', hint = 'ledger.unbalanced';
  end if;
  select count(*) into bad
    from app.posting p join app.ledger_account la on la.id = p.ledger_account_id
   where p.workspace_id = p_workspace and p.journal_entry_id = p_entry
     and (p.currency <> la.currency or (p.currency = func_ccy and p.amount_minor <> p.functional_amount_minor));
  if bad > 0 then
    raise exception 'journal entry % has postings whose currency does not match their account', p_entry
      using errcode = 'check_violation', hint = 'ledger.currency_mismatch';
  end if;
end $$;

create function app.check_entry_balance_from_posting() returns trigger language plpgsql as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform app.assert_entry_balanced(new.workspace_id, new.journal_entry_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or old.journal_entry_id <> new.journal_entry_id) then
    perform app.assert_entry_balanced(old.workspace_id, old.journal_entry_id);
  end if;
  return null;
end $$;
create constraint trigger posting_balanced after insert or update or delete on app.posting
  deferrable initially deferred for each row execute function app.check_entry_balance_from_posting();

create function app.check_entry_balance_from_entry() returns trigger language plpgsql as $$
begin
  perform app.assert_entry_balanced(new.workspace_id, new.id);
  return null;
end $$;
create constraint trigger journal_entry_balanced after insert on app.journal_entry
  deferrable initially deferred for each row execute function app.check_entry_balance_from_entry();

-- DE-08..10: protected entries (locked, or dated inside a locked period) cannot change except through
-- the audited unlock path, which sets app.allow_locked_edit for one transaction.
create function app.locked_through(p_workspace uuid, p_entity uuid) returns date
  language sql stable security definer set search_path = app, pg_temp as $$
  select locked_through from app.period_lock where workspace_id = p_workspace and entity_id = p_entity
$$;

create function app.guard_journal_entry() returns trigger language plpgsql as $$
declare lock_date date;
begin
  if app.locked_edit_allowed() then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') then
    lock_date := app.locked_through(old.workspace_id, old.entity_id);
    if old.locked or old.entry_date <= lock_date then
      -- Locking an entry (false → true) and touching bookkeeping columns is allowed.
      if tg_op = 'UPDATE' and (to_jsonb(new) - array['locked', 'version', 'updated_at'])
                            = (to_jsonb(old) - array['locked', 'version', 'updated_at'])
                          and (new.locked or not old.locked) then
        return new;
      end if;
      raise exception 'journal entry % is locked (reconciled or in a closed period)', old.id
        using errcode = 'check_violation', hint = 'period.locked';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    lock_date := app.locked_through(new.workspace_id, new.entity_id);
    if new.entry_date <= lock_date then
      raise exception 'period is locked through %; cannot post an entry dated %', lock_date, new.entry_date
        using errcode = 'check_violation', hint = 'period.locked';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger guard_journal_entry before insert or update or delete on app.journal_entry
  for each row execute function app.guard_journal_entry();

create function app.guard_posting() returns trigger language plpgsql as $$
declare je record;
begin
  if app.locked_edit_allowed() then return coalesce(new, old); end if;
  select locked, entry_date, entity_id into je
    from app.journal_entry
   where workspace_id = coalesce(new.workspace_id, old.workspace_id)
     and id = coalesce(new.journal_entry_id, old.journal_entry_id);
  if not found then return coalesce(new, old); end if; -- cascade from a permitted entry delete
  if je.locked or je.entry_date <= app.locked_through(old.workspace_id, je.entity_id)
     or je.entry_date <= app.locked_through(new.workspace_id, je.entity_id)
     or (tg_op <> 'INSERT' and old.cleared = 'reconciled') then
    -- Status-only changes are allowed; un-reconciling is not.
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['cleared', 'reconciliation_id', 'updated_at'])
         = (to_jsonb(old) - array['cleared', 'reconciliation_id', 'updated_at'])
       and not (old.cleared = 'reconciled' and new.cleared <> 'reconciled') then
      return new;
    end if;
    raise exception 'posting belongs to a locked or reconciled entry'
      using errcode = 'check_violation', hint = 'period.locked';
  end if;
  return coalesce(new, old);
end $$;
create trigger guard_posting before insert or update or delete on app.posting
  for each row execute function app.guard_posting();

-- ---------------------------------------------------------------------------------------------
-- Change feed (ADR-0008) and audit log (NFR-03), written in the same transaction as the change.
-- ---------------------------------------------------------------------------------------------
create function app.record_change() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare r jsonb; ws uuid; next_seq bigint;
begin
  r := to_jsonb(coalesce(new, old));
  ws := coalesce((r ->> 'workspace_id')::uuid, case when tg_table_name = 'workspace' then (r ->> 'id')::uuid end);
  if ws is null then return null; end if;
  if tg_op = 'DELETE' and not exists (select 1 from app.workspace where id = ws) then return null; end if;
  insert into app.workspace_seq as s (workspace_id, seq) values (ws, 1)
    on conflict (workspace_id) do update set seq = s.seq + 1
    returning seq into next_seq;
  insert into app.change_log (workspace_id, seq, table_name, row_id, op, entity_id, restricted)
  values (ws, next_seq, tg_table_name,
          coalesce(r ->> 'id', r ->> 'ledger_account_id', concat_ws(':', r ->> 'transaction_id', r ->> 'tag_id', r ->> 'user_id', r ->> 'entity_id')),
          lower(tg_op),
          case when tg_table_name = 'entity' then (r ->> 'id')::uuid
               when tg_table_name = 'transaction' then (r ->> 'primary_entity_id')::uuid
               else (r ->> 'entity_id')::uuid end,
          coalesce((r ->> 'restricted')::boolean, false));
  return null;
end $$;

create function app.audit_row() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare o jsonb; n jsonb; d jsonb; k text;
begin
  o := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  if tg_op = 'UPDATE' then
    d := '{}';
    for k in select jsonb_object_keys(n) loop
      if k not in ('updated_at', 'version') and (o -> k) is distinct from (n -> k) then
        d := d || jsonb_build_object(k, case when k like '%\_enc' then '"[redacted]"'::jsonb
                                             else jsonb_build_array(o -> k, n -> k) end);
      end if;
    end loop;
    if d = '{}' then return null; end if;
  else
    d := coalesce(n, o);
    for k in select jsonb_object_keys(d) loop
      if k like '%\_enc' then d := d || jsonb_build_object(k, '[redacted]'::text); end if;
    end loop;
  end if;
  insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
  values (coalesce((coalesce(n, o) ->> 'workspace_id')::uuid, (coalesce(n, o) ->> 'id')::uuid),
          app.current_user_id(),
          coalesce(nullif(current_setting('app.actor_type', true), ''), 'user'),
          tg_table_name || '.' || lower(tg_op), tg_table_name,
          coalesce(coalesce(n, o) ->> 'id', coalesce(n, o) ->> 'ledger_account_id', coalesce(n, o) ->> 'entity_id'),
          d);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['workspace', 'workspace_member', 'entity', 'entity_grant', 'family_member', 'category_group',
                           'ledger_account', 'bank_account', 'payee', 'tag', 'transaction', 'transaction_tag',
                           'journal_entry', 'posting', 'period_lock'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.record_change()',
                   t || '_change', t);
  end loop;
  foreach t in array array['workspace', 'workspace_member', 'entity', 'entity_grant', 'ledger_account', 'bank_account',
                           'transaction', 'journal_entry', 'posting', 'period_lock'] loop
    execute format('create trigger %I after insert or update or delete on app.%I for each row execute function app.audit_row()',
                   t || '_audit', t);
  end loop;
  foreach t in array array['workspace', 'entity', 'family_member', 'ledger_account', 'transaction', 'journal_entry'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_versioned()', t || '_touch', t);
  end loop;
  foreach t in array array['app_user', 'workspace_member', 'entity_grant', 'category_group', 'bank_account', 'payee', 'tag',
                           'period_lock'] loop
    execute format('create trigger %I before update on app.%I for each row execute function app.touch()', t || '_touch', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER so policies don't recurse through RLS)
-- ---------------------------------------------------------------------------------------------
create function app.current_member_role() returns text
  language sql stable security definer set search_path = app, pg_temp as $$
  select role from app.workspace_member
   where workspace_id = app.current_workspace_id() and user_id = app.current_user_id() and status = 'active'
$$;

create function app.is_member() returns boolean
  language sql stable as $$ select app.current_member_role() is not null $$;

create function app.workspace_has_members(p_workspace uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.workspace_member where workspace_id = p_workspace)
$$;

-- Entity access: owner → all; explicit grant wins; otherwise partner = write on personal,
-- viewer = read on personal, accountant = none (docs/design/07 §2, assumption 5).
create function app.entity_access(p_entity uuid) returns text
  language sql stable security definer set search_path = app, pg_temp as $$
  with m as (
    select role from app.workspace_member
     where workspace_id = app.current_workspace_id() and user_id = app.current_user_id() and status = 'active'
  )
  select case
    when (select role from m) is null then 'none'
    when (select role from m) = 'owner' then 'write'
    else coalesce(
      (select access from app.entity_grant
        where workspace_id = app.current_workspace_id() and user_id = app.current_user_id() and entity_id = p_entity),
      case when (select type from app.entity where id = p_entity) = 'personal'
           then case (select role from m) when 'partner' then 'write' when 'viewer' then 'read' else 'none' end
           else 'none' end)
  end
$$;

create function app.can_read_entity(p_entity uuid) returns boolean
  language sql stable as $$ select app.entity_access(p_entity) in ('read', 'write') $$;

create function app.can_write_entity(p_entity uuid) returns boolean
  language sql stable as $$ select app.entity_access(p_entity) = 'write' $$;

-- PAY-09: restricted (payslip) entries are visible to owners and to the user linked to the member.
create function app.can_read_restricted(p_member uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select app.current_member_role() = 'owner'
      or exists (select 1 from app.family_member
                  where workspace_id = app.current_workspace_id() and id = p_member
                    and linked_user_id = app.current_user_id())
$$;

-- Resolve (or create) the app user for an identity. Used by the auth layer before any workspace context exists.
create function app.resolve_user(p_identity_id text, p_email citext, p_display_name text) returns uuid
  language plpgsql security definer set search_path = app, pg_temp as $$
declare uid uuid;
begin
  select id into uid from app.app_user where identity_id = p_identity_id;
  if uid is null then
    insert into app.app_user (identity_id, email, display_name)
    values (p_identity_id, p_email, coalesce(p_display_name, ''))
    on conflict (email) do update set identity_id = coalesce(app.app_user.identity_id, excluded.identity_id)
    returning id into uid;
  end if;
  return uid;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['app_user', 'workspace', 'workspace_member', 'entity', 'entity_grant', 'family_member',
                           'category_group', 'ledger_account', 'bank_account', 'payee', 'tag', 'transaction',
                           'transaction_tag', 'journal_entry', 'posting', 'period_lock', 'period_lock_event',
                           'audit_log', 'workspace_seq', 'change_log', 'idempotency_key'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
end $$;

-- Users: yourself, and people who share the current workspace.
create policy app_user_select on app.app_user for select using (
  id = app.current_user_id()
  or (app.is_member() and exists (select 1 from app.workspace_member m
                                   where m.workspace_id = app.current_workspace_id() and m.user_id = app_user.id)));
create policy app_user_update on app.app_user for update using (id = app.current_user_id()) with check (id = app.current_user_id());

-- Workspaces: only those you are an active member of (setting app.workspace_id alone grants nothing).
-- Creating one is INSERT without RETURNING, followed by the owner membership row.
create policy workspace_select on app.workspace for select using (
  exists (select 1 from app.workspace_member m where m.workspace_id = workspace.id and m.user_id = app.current_user_id() and m.status = 'active'));
create policy workspace_insert on app.workspace for insert with check (id = app.current_workspace_id());
create policy workspace_update on app.workspace for update
  using (id = app.current_workspace_id() and app.current_member_role() = 'owner');

create policy member_select on app.workspace_member for select using (
  (workspace_id = app.current_workspace_id() and app.is_member()) or user_id = app.current_user_id());
create policy member_insert on app.workspace_member for insert with check (
  workspace_id = app.current_workspace_id()
  and (app.current_member_role() = 'owner'
       or (not app.workspace_has_members(workspace_id) and user_id = app.current_user_id() and role = 'owner')));
create policy member_update on app.workspace_member for update
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');
create policy member_delete on app.workspace_member for delete
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');

-- Entities: readable per access rules; created and configured by owners.
create policy entity_select on app.entity for select using (workspace_id = app.current_workspace_id() and app.can_read_entity(id));
create policy entity_write on app.entity for all
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner')
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');

create policy grant_all on app.entity_grant for all
  using (workspace_id = app.current_workspace_id() and (app.current_member_role() = 'owner' or user_id = app.current_user_id()))
  with check (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');

-- Entity-scoped tables: read and write follow entity access (UP-04, BIZ-13).
do $$
declare t text;
begin
  foreach t in array array['category_group', 'ledger_account', 'period_lock'] loop
    execute format($f$create policy %I on app.%I for select using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for insert with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_insert', t);
    execute format($f$create policy %I on app.%I for update using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_update', t);
    execute format($f$create policy %I on app.%I for delete using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id))$f$, t || '_delete', t);
  end loop;
end $$;

create policy bank_account_all on app.bank_account for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account la where la.workspace_id = bank_account.workspace_id and la.id = bank_account.ledger_account_id))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.ledger_account la where la.workspace_id = bank_account.workspace_id and la.id = bank_account.ledger_account_id
                     and app.can_write_entity(la.entity_id)));

create policy transaction_select on app.transaction for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(primary_entity_id));
create policy transaction_write on app.transaction for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(primary_entity_id))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(primary_entity_id));

create policy transaction_tag_all on app.transaction_tag for all
  using (workspace_id = app.current_workspace_id() and app.is_member()
         and exists (select 1 from app.transaction t where t.workspace_id = transaction_tag.workspace_id and t.id = transaction_tag.transaction_id))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.transaction t where t.workspace_id = transaction_tag.workspace_id and t.id = transaction_tag.transaction_id));

create policy journal_entry_select on app.journal_entry for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id)
         and (not restricted or app.can_read_restricted(restricted_member_id)));
create policy journal_entry_write on app.journal_entry for all
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
         and (not restricted or app.can_read_restricted(restricted_member_id)))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

create policy posting_select on app.posting for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id)
         and (not restricted or exists (select 1 from app.journal_entry je
                                         where je.workspace_id = posting.workspace_id and je.id = posting.journal_entry_id)));
-- Separate per-command policies: a FOR ALL policy would also widen SELECT past the restricted check.
create policy posting_insert on app.posting for insert
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));
create policy posting_update on app.posting for update
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
         and (not restricted or exists (select 1 from app.journal_entry je
                                         where je.workspace_id = posting.workspace_id and je.id = posting.journal_entry_id)))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));
create policy posting_delete on app.posting for delete
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
         and (not restricted or exists (select 1 from app.journal_entry je
                                         where je.workspace_id = posting.workspace_id and je.id = posting.journal_entry_id)));

-- Workspace-wide tables.
do $$
declare t text;
begin
  foreach t in array array['family_member', 'payee', 'tag', 'idempotency_key'] loop
    execute format($f$create policy %I on app.%I for select using (workspace_id = app.current_workspace_id() and app.is_member())$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for insert with check (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner'))$f$, t || '_insert', t);
    execute format($f$create policy %I on app.%I for update using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner'))$f$, t || '_update', t);
    execute format($f$create policy %I on app.%I for delete using (workspace_id = app.current_workspace_id() and app.current_member_role() in ('owner', 'partner'))$f$, t || '_delete', t);
  end loop;
end $$;

create policy period_lock_event_select on app.period_lock_event for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id));
create policy period_lock_event_insert on app.period_lock_event for insert
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));

create policy audit_log_select on app.audit_log for select
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');
create policy audit_log_insert on app.audit_log for insert with check (workspace_id = app.current_workspace_id() and app.is_member());

create policy change_log_select on app.change_log for select
  using (workspace_id = app.current_workspace_id() and app.is_member() and (entity_id is null or app.can_read_entity(entity_id)));

-- ---------------------------------------------------------------------------------------------
-- Grants for the runtime role
-- ---------------------------------------------------------------------------------------------
grant select, insert, update, delete on all tables in schema app to montra_app;
revoke update, delete on app.audit_log from montra_app;
revoke insert, update, delete on app.change_log from montra_app;
revoke all on app.workspace_seq from montra_app;
revoke update, delete on app.period_lock_event from montra_app;
grant usage on all sequences in schema app to montra_app;
grant execute on all functions in schema app to montra_app;
