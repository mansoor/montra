-- Phase 7: employers and payslips (PAY-01..09; design 03 §8, 04 §14, ADR-0016).

-- ---------------------------------------------------------------------------------------------
-- Restricted entries with one public line. A payslip's entry is restricted, but its net-pay line stays visible:
-- the deposit is a bank fact, already on the statement, and hiding it would make a shared account's balance wrong
-- for everyone else. Gross pay, taxes and deductions stay private. See ADR-0016 §2.
-- ---------------------------------------------------------------------------------------------
alter table app.posting add column public_line boolean not null default false;

create or replace function app.posting_inherit_entry() returns trigger language plpgsql as $$
declare je record;
begin
  select entity_id, entry_date, restricted, restricted_member_id into je
    from app.journal_entry where workspace_id = new.workspace_id and id = new.journal_entry_id;
  if not found then
    raise exception 'journal entry % not found', new.journal_entry_id using errcode = 'foreign_key_violation';
  end if;
  new.entity_id := je.entity_id;
  new.entry_date := je.entry_date;
  new.restricted := je.restricted and not new.public_line;
  new.restricted_member_id := case when je.restricted and not new.public_line then je.restricted_member_id end;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;

-- Postings decide from their own columns now: no join back to the entry, whose policy below is wider.
drop policy posting_select on app.posting;
drop policy posting_update on app.posting;
drop policy posting_delete on app.posting;
create policy posting_select on app.posting for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id)
         and (not restricted or app.can_read_restricted(restricted_member_id)));
create policy posting_update on app.posting for update
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
         and (not restricted or app.can_read_restricted(restricted_member_id)))
  with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id));
create policy posting_delete on app.posting for delete
  using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
         and (not restricted or app.can_read_restricted(restricted_member_id)));

-- An entry with a public line is readable (date, description), so the line shows in the account's register. Its
-- restricted postings are still hidden by their own policy. Definer: the posting policy must not recurse.
create function app.entry_has_public_line(p_workspace uuid, p_entry uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.posting
                  where workspace_id = p_workspace and journal_entry_id = p_entry and public_line)
$$;
grant execute on function app.entry_has_public_line(uuid, uuid) to montra_app;

drop policy journal_entry_select on app.journal_entry;
create policy journal_entry_select on app.journal_entry for select
  using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id)
         and (not restricted or app.can_read_restricted(restricted_member_id)
              or app.entry_has_public_line(workspace_id, id)));

-- ---------------------------------------------------------------------------------------------
-- Employers and other income sources (PAY-01), per member.
-- ---------------------------------------------------------------------------------------------
create table app.employer (
  workspace_id          uuid not null references app.workspace (id) on delete cascade,
  id                    uuid not null default gen_random_uuid(),
  entity_id             uuid not null,
  member_id             uuid not null,
  name                  text not null check (length(name) between 1 and 200),
  type                  text not null default 'employer'
                          check (type in ('employer', 'freelance', 'pension', 'benefits', 'other')),
  pay_frequency         text not null default 'monthly'
                          check (pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly')),
  deposit_account_id    uuid not null,
  payee_key             text,                -- how the pay appears on the statement (normalized), for matching
  retirement_account_id uuid,                -- where 401(k)-style deductions go; created on first use
  archived_at           timestamptz,
  restricted            boolean not null default true,   -- the change feed lists these for owners only
  version               bigint not null default 1,
  created_by            uuid references app.app_user (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id),
  foreign key (workspace_id, deposit_account_id) references app.ledger_account (workspace_id, id),
  foreign key (workspace_id, retirement_account_id) references app.ledger_account (workspace_id, id)
);
create index employer_member on app.employer (workspace_id, member_id);

-- ---------------------------------------------------------------------------------------------
-- Payslips (PAY-02..05). `gross_minor` and `net_minor` are copies of what the lines add up to, kept for lists.
-- A payslip is a draft until confirmed; confirming posts its entry to `transaction_id`, which is either a new
-- transaction or the imported deposit it matched (PAY-04; `deposit_spec` keeps that deposit's original spec, so
-- deleting the payslip gives the plain deposit back).
-- ---------------------------------------------------------------------------------------------
create table app.payslip (
  workspace_id      uuid not null references app.workspace (id) on delete cascade,
  id                uuid not null default gen_random_uuid(),
  entity_id         uuid not null,
  employer_id       uuid not null,
  member_id         uuid not null,
  status            text not null default 'processing'
                      check (status in ('processing', 'needs_review', 'posted', 'rejected')),
  pay_date          date,
  period_start      date,
  period_end        date,
  currency          char(3) not null,
  gross_minor       bigint not null default 0,
  net_minor         bigint not null default 0,
  attachment_ids    uuid[] not null default '{}',
  extraction        jsonb,                     -- { provider, model, confidence, warnings[], mode }
  transaction_id    uuid,
  deposit_spec      jsonb,
  match_candidates  jsonb,                     -- [{ transactionId, date, amount, payee }]: more than one possible deposit
  restricted        boolean not null default true,
  created_by        uuid references app.app_user (id),
  version           bigint not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, employer_id) references app.employer (workspace_id, id),
  foreign key (workspace_id, member_id) references app.family_member (workspace_id, id),
  foreign key (workspace_id, transaction_id) references app.transaction (workspace_id, id),
  check (period_start is null or period_end is null or period_end >= period_start)
);
create index payslip_member_date on app.payslip (workspace_id, member_id, pay_date desc);
create index payslip_employer_date on app.payslip (workspace_id, employer_id, pay_date desc);
create unique index payslip_transaction on app.payslip (workspace_id, transaction_id) where transaction_id is not null;

create table app.payslip_line (
  workspace_id       uuid not null,
  id                 uuid not null default gen_random_uuid(),
  payslip_id         uuid not null,
  line_no            integer not null check (line_no > 0),
  section            text not null check (section in ('earning', 'pre_tax', 'tax', 'post_tax', 'employer')),
  code               text not null check (length(code) between 1 and 40),
  label              text not null check (length(label) between 1 and 200),
  amount_minor       bigint not null check (amount_minor >= 0),
  ytd_minor          bigint,
  ledger_account_id  uuid,                     -- overrides where the line posts
  primary key (workspace_id, id),
  unique (workspace_id, payslip_id, line_no),
  foreign key (workspace_id, payslip_id) references app.payslip (workspace_id, id) on delete cascade,
  foreign key (workspace_id, ledger_account_id) references app.ledger_account (workspace_id, id)
);

-- PAY-07: the expected income that follows an employer's payslips.
alter table app.expected_income add column employer_id uuid;
alter table app.expected_income
  add foreign key (workspace_id, employer_id) references app.employer (workspace_id, id) on delete set null (employer_id);
create unique index expected_income_employer on app.expected_income (workspace_id, employer_id) where employer_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Triggers, RLS and grants. PAY-09: owners and the member's linked user only.
-- ---------------------------------------------------------------------------------------------
create trigger employer_touch before update on app.employer for each row execute function app.touch_versioned();
create trigger payslip_touch before update on app.payslip for each row execute function app.touch_versioned();
create trigger employer_change after insert or update or delete on app.employer for each row execute function app.record_change();
create trigger payslip_change after insert or update or delete on app.payslip for each row execute function app.record_change();
create trigger employer_audit after insert or update or delete on app.employer for each row execute function app.audit_row();
create trigger payslip_audit after insert or update or delete on app.payslip for each row execute function app.audit_row();

do $$
declare t text;
begin
  foreach t in array array['employer', 'payslip', 'payslip_line'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
  end loop;
  foreach t in array array['employer', 'payslip'] loop
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id)
             and app.can_read_restricted(member_id))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
             and app.can_read_restricted(member_id))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
             and app.can_read_restricted(member_id))$f$, t || '_write', t);
  end loop;
end $$;

-- Lines follow their payslip.
create policy payslip_line_select on app.payslip_line for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.payslip p where p.workspace_id = payslip_line.workspace_id and p.id = payslip_line.payslip_id));
create policy payslip_line_write on app.payslip_line for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.payslip p where p.workspace_id = payslip_line.workspace_id and p.id = payslip_line.payslip_id
                     and app.can_write_entity(p.entity_id)))
  with check (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.payslip p where p.workspace_id = payslip_line.workspace_id and p.id = payslip_line.payslip_id
                     and app.can_write_entity(p.entity_id)));

grant select, insert, update, delete on app.employer, app.payslip, app.payslip_line to montra_app;
