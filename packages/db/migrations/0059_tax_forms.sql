-- Tax forms received (TAX-01..TAX-10, ADR-0052): W-2, 1099-INT, 1099-DIV and 1098, kept, matched and checked against
-- the books. This migration is PR 1's: the forms, what they're matched to, waivers for expected forms, the owner's
-- setting that lets accountants see members' forms, and the Schedule B tax lines on the personal chart's interest and
-- dividend categories. Reading, reconciliation and the tax package come later and need no schema of their own (the
-- reminder's notification type is 0060).
--
-- Who sees a form (§8.4): the person it's for, owners and admins (the payslip rule, PAY-09), and accountants while the
-- owner's setting is on. Always bounded by the books it belongs to. One helper, app.can_read_tax_form, holds the rule.

-- -----------------------------------------------------------------------------
-- The owner's setting (§3, §8.4): accountants see members' tax forms and include them in tax packages. Off by default.
-- A typed column, not a key in ai_settings, because row-level security reads it.
-- -----------------------------------------------------------------------------
alter table app.workspace add column accountant_sees_tax_forms boolean not null default false;

-- Defence in depth behind the API's owner check: through the app's role, only the owner changes it. Admins can update
-- the workspace row (its name, security rules) but not this column; other roles can't update the row at all.
create function app.guard_accountant_tax_forms() returns trigger
  language plpgsql set search_path = app, pg_temp as $$
begin
  if new.accountant_sees_tax_forms is distinct from old.accountant_sees_tax_forms
     and current_user = 'montra_app' and app.current_member_role() is distinct from 'owner' then
    raise exception 'only the owner can change whether accountants see tax forms'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function app.guard_accountant_tax_forms() from public;
create trigger workspace_accountant_tax_forms_guard before update of accountant_sees_tax_forms on app.workspace
  for each row execute function app.guard_accountant_tax_forms();

-- -----------------------------------------------------------------------------
-- Who reads a form for a person (§8.4). Null person (not known yet): owners and admins, and accountants with the
-- setting on; the policies add the uploader. A future role-based model (ADR-0053) would change only this function.
-- -----------------------------------------------------------------------------
create function app.can_read_tax_form(p_member uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select app.can_read_restricted(p_member)
      or (app.current_member_role() = 'accountant'
          and coalesce((select w.accountant_sees_tax_forms from app.workspace w
                         where w.id = app.current_workspace_id()), false))
$$;
revoke all on function app.can_read_tax_form(uuid) from public;
grant execute on function app.can_read_tax_form(uuid) to montra_app;

-- -----------------------------------------------------------------------------
-- The forms (§3). Boxes are one JSON document per form, checked by `parseTaxFormBoxes` in @montra/domain: money as
-- strings of integer minor units. Identifiers are kept short: the person's SSN, an SSN-shaped payer TIN and the
-- account number as their last four digits only; an issuer's EIN in full.
-- -----------------------------------------------------------------------------
create table app.tax_form (
  workspace_id      uuid not null references app.workspace (id) on delete cascade,
  id                uuid not null default gen_random_uuid(),
  -- The books it belongs to: from what it's matched to, the personal books until then.
  entity_id         uuid not null,
  tax_year          smallint not null check (tax_year between 2000 and 2100),
  -- Phase 1 kinds; later phases widen the check.
  kind              text not null check (kind in ('w2', '1099_int', '1099_div', '1098')),
  -- The CORRECTED box, or a W-2c.
  corrected         boolean not null default false,
  -- The earlier form a corrected one replaces.
  supersedes_id     uuid,
  issuer_name       text check (length(issuer_name) between 1 and 200),
  issuer_ein        text check (issuer_ein ~ '^[0-9]{9}$'),
  issuer_tin_last4  text check (issuer_tin_last4 ~ '^[0-9]{4}$'),
  person_tin_last4  text check (person_tin_last4 ~ '^[0-9]{4}$'),
  account_last4     text check (account_last4 ~ '^[0-9]{4}$'),
  -- The household member it's for; null until known.
  person_member_id  uuid,
  -- The change feed would list these for owners only; tax forms aren't synced (ADR-0052 §10), so it's for parity
  -- with payslips and the backup's reading of restricted rows.
  restricted        boolean not null default true,
  boxes             jsonb not null default '{}'::jsonb check (jsonb_typeof(boxes) = 'object'),
  -- Files (one file can hold several forms, as a consolidated 1099 does), the pages this form is on, and the file's
  -- hash for refusing the same file twice.
  file_ids          uuid[] not null default '{}' check (cardinality(file_ids) <= 20),
  pages             integer[],
  sha256            text check (sha256 ~ '^[0-9a-f]{64}$'),
  -- reading → review (needs a person) → confirmed; or dismissed, or superseded by a corrected form.
  status            text not null default 'review'
                    check (status in ('reading', 'review', 'confirmed', 'dismissed', 'superseded')),
  -- Why it's in Review: unread, no_match, no_person, person_conflict, differs, probable_copy.
  reason            text,
  source            text not null check (source in ('upload', 'scan', 'typed')),
  -- The masked extraction, cleared once confirmed; what was found (signals, candidates with reasons); the accepted
  -- differences per box with their notes (§5.6).
  reading           jsonb,
  detected          jsonb,
  accepted          jsonb,
  job_id            uuid,
  created_by        uuid references app.app_user (id),
  confirmed_by      uuid references app.app_user (id),
  confirmed_at      timestamptz,
  -- In the Trash (30 days) when set.
  deleted_at        timestamptz,
  version           bigint not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_member_id) references app.family_member (workspace_id, id)
    on delete set null (person_member_id),
  foreign key (workspace_id, supersedes_id) references app.tax_form (workspace_id, id) on delete set null (supersedes_id),
  -- An SSN-shaped payer TIN keeps its last four only; an EIN-shaped one is kept whole. Never both.
  check (issuer_ein is null or issuer_tin_last4 is null),
  check (supersedes_id is null or supersedes_id <> id)
);
create index tax_form_year on app.tax_form (workspace_id, tax_year, kind) where deleted_at is null;
create index tax_form_person on app.tax_form (workspace_id, person_member_id, tax_year);
create index tax_form_sha on app.tax_form (workspace_id, sha256) where sha256 is not null;
create index tax_form_trash on app.tax_form (deleted_at) where deleted_at is not null;

create trigger tax_form_touch before update on app.tax_form for each row execute function app.touch_versioned();

-- What a form is matched to (§3): an employer (a W-2) or one or more accounts (a bank's 1099-INT often covers every
-- account the person has there; a 1098 names the mortgage account carrying the loan schedule).
create table app.tax_form_target (
  workspace_id  uuid not null,
  id            uuid not null default gen_random_uuid(),
  tax_form_id   uuid not null,
  employer_id   uuid,
  account_id    uuid,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, tax_form_id) references app.tax_form (workspace_id, id) on delete cascade,
  foreign key (workspace_id, employer_id) references app.employer (workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id) references app.ledger_account (workspace_id, id) on delete cascade,
  check ((employer_id is null) <> (account_id is null))
);
create unique index tax_form_target_employer on app.tax_form_target (workspace_id, tax_form_id, employer_id)
  where employer_id is not null;
create unique index tax_form_target_account on app.tax_form_target (workspace_id, tax_form_id, account_id)
  where account_id is not null;
create index tax_form_target_of_employer on app.tax_form_target (workspace_id, employer_id) where employer_id is not null;
create index tax_form_target_of_account on app.tax_form_target (workspace_id, account_id) where account_id is not null;

-- An expected form that won't come or is covered elsewhere (§7.1). Expected forms themselves are inferred, never
-- stored. The person and books are kept on the waiver (from its employer, or given for an account) so it's read by
-- the same rule as a form.
create table app.tax_form_waiver (
  workspace_id      uuid not null references app.workspace (id) on delete cascade,
  id                uuid not null default gen_random_uuid(),
  entity_id         uuid not null,
  tax_year          smallint not null check (tax_year between 2000 and 2100),
  kind              text not null check (kind in ('w2', '1099_int', '1099_div', '1098')),
  employer_id       uuid,
  account_id        uuid,
  person_member_id  uuid,
  reason            text not null check (reason in ('not_issued', 'combined', 'other')),
  note              text check (length(note) <= 500),
  created_by        uuid references app.app_user (id),
  created_at        timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, entity_id) references app.entity (workspace_id, id) on delete cascade,
  foreign key (workspace_id, employer_id) references app.employer (workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id) references app.ledger_account (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_member_id) references app.family_member (workspace_id, id)
    on delete set null (person_member_id),
  check ((employer_id is null) <> (account_id is null)),
  -- A W-2 comes from an employer; the others from an account.
  check ((kind = 'w2') = (employer_id is not null))
);
create unique index tax_form_waiver_one on app.tax_form_waiver
  (workspace_id, tax_year, kind, coalesce(employer_id, account_id));

-- -----------------------------------------------------------------------------
-- An accountant with the setting on reads a member's W-2 but not their payslips (PAY-09 is unchanged). Their W-2's
-- checks get the payslip sums from here: only the sums of §5.2, for the form's employer, person and year, and only when
-- the form itself is readable. Posted payslips paid in the tax year; nothing per payslip.
-- -----------------------------------------------------------------------------
create function app.tax_form_payslip_totals(p_form uuid)
  returns table (
    payslips          integer,
    earnings          bigint,
    pre_tax           bigint,
    pre_tax_401k      bigint,
    hsa               bigint,
    roth_401k         bigint,
    fed_tax           bigint,
    social_security   bigint,
    medicare          bigint,
    state_tax         bigint
  )
  language plpgsql stable security definer set search_path = app, pg_temp as $$
declare f record;
begin
  select t.workspace_id, t.tax_year, t.person_member_id, t.entity_id, t.kind, t.created_by into f
    from app.tax_form t
   where t.workspace_id = app.current_workspace_id() and t.id = p_form and t.deleted_at is null;
  if not found or f.kind <> 'w2' or f.person_member_id is null
     or not app.can_read_entity(f.entity_id) or not app.can_read_tax_form(f.person_member_id) then
    return;
  end if;
  return query
    select count(distinct p.id)::integer,
           coalesce(sum(l.amount_minor) filter (where l.section = 'earning'), 0)::bigint,
           coalesce(sum(l.amount_minor) filter (where l.section = 'pre_tax'), 0)::bigint,
           coalesce(sum(l.amount_minor) filter (where l.section = 'pre_tax' and l.code = '401k'), 0)::bigint,
           coalesce(sum(l.amount_minor) filter (where l.section in ('pre_tax', 'employer') and l.code = 'hsa'), 0)::bigint,
           coalesce(sum(l.amount_minor) filter (where l.section = 'post_tax' and l.code = 'roth_401k'), 0)::bigint,
           coalesce(sum(l.amount_minor) filter (where l.section = 'tax' and l.code = 'fed_tax'), 0)::bigint,
           coalesce(sum(l.amount_minor) filter (where l.section = 'tax' and l.code = 'social_security'), 0)::bigint,
           coalesce(sum(l.amount_minor) filter (where l.section = 'tax' and l.code = 'medicare'), 0)::bigint,
           coalesce(sum(l.amount_minor) filter (where l.section = 'tax' and l.code = 'state_tax'), 0)::bigint
      from app.payslip p
      left join app.payslip_line l on l.workspace_id = p.workspace_id and l.payslip_id = p.id
     where p.workspace_id = f.workspace_id
       and p.member_id = f.person_member_id
       and p.status = 'posted'
       and p.pay_date between make_date(f.tax_year, 1, 1) and make_date(f.tax_year, 12, 31)
       and p.employer_id in (select tt.employer_id from app.tax_form_target tt
                              where tt.workspace_id = f.workspace_id and tt.tax_form_id = p_form
                                and tt.employer_id is not null);
end $$;
revoke all on function app.tax_form_payslip_totals(uuid) from public;
grant execute on function app.tax_form_payslip_totals(uuid) to montra_app;

-- -----------------------------------------------------------------------------
-- Row-level security (§8.4). Read: the person, owners and admins, accountants with the setting on; while the person
-- isn't known, also the uploader. Always bounded by the books. Write: the same people where they can write the books,
-- which leaves viewers out.
-- -----------------------------------------------------------------------------
alter table app.tax_form enable row level security;
alter table app.tax_form force row level security;
alter table app.tax_form_target enable row level security;
alter table app.tax_form_target force row level security;
alter table app.tax_form_waiver enable row level security;
alter table app.tax_form_waiver force row level security;

do $$
declare t text;
begin
  foreach t in array array['tax_form', 'tax_form_waiver'] loop
    execute format($f$create policy %I on app.%I for select
      using (workspace_id = app.current_workspace_id() and app.can_read_entity(entity_id)
             and (app.can_read_tax_form(person_member_id)
                  or (person_member_id is null and created_by = app.current_user_id())))$f$, t || '_select', t);
    execute format($f$create policy %I on app.%I for all
      using (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
             and (app.can_read_tax_form(person_member_id)
                  or (person_member_id is null and created_by = app.current_user_id())))
      with check (workspace_id = app.current_workspace_id() and app.can_write_entity(entity_id)
             and (app.can_read_tax_form(person_member_id)
                  or (person_member_id is null and created_by = app.current_user_id())))$f$, t || '_write', t);
  end loop;
end $$;

-- Targets follow their form: the subquery runs under the form's own policy.
create policy tax_form_target_select on app.tax_form_target for select
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.tax_form f
                      where f.workspace_id = tax_form_target.workspace_id and f.id = tax_form_target.tax_form_id));
create policy tax_form_target_write on app.tax_form_target for all
  using (workspace_id = app.current_workspace_id()
         and exists (select 1 from app.tax_form f
                      where f.workspace_id = tax_form_target.workspace_id and f.id = tax_form_target.tax_form_id
                        and app.can_write_entity(f.entity_id)))
  with check (workspace_id = app.current_workspace_id()
              and exists (select 1 from app.tax_form f
                           where f.workspace_id = tax_form_target.workspace_id and f.id = tax_form_target.tax_form_id
                             and app.can_write_entity(f.entity_id)));

grant select, insert, update, delete on app.tax_form, app.tax_form_target, app.tax_form_waiver to montra_app;

-- -----------------------------------------------------------------------------
-- The match memory learns tax forms' issuers and people (§4). Members write these kinds too, for their own forms.
-- -----------------------------------------------------------------------------
alter table app.match_memory drop constraint match_memory_kind_check;
alter table app.match_memory add constraint match_memory_kind_check
  check (kind in ('statement', 'bill', 'tax_issuer', 'tax_person'));

alter policy match_memory_write on app.match_memory
  using (workspace_id = app.current_workspace_id()
         and (app.current_member_role() in ('owner', 'admin', 'partner', 'accountant')
              or (kind in ('bill', 'tax_issuer', 'tax_person') and app.current_member_role() = 'member')))
  with check (workspace_id = app.current_workspace_id()
              and (app.current_member_role() in ('owner', 'admin', 'partner', 'accountant')
                   or (kind in ('bill', 'tax_issuer', 'tax_person') and app.current_member_role() = 'member')));

-- -----------------------------------------------------------------------------
-- Schedule B (§5.7): the personal chart's "Interest income" and "Dividends" carry part I and part II's tax lines, so
-- interest and dividends are found by tax line first. The ref.tax_line rows are reference data
-- (packages/db/src/reference/tax.ts); ledger_account.tax_line_code isn't a foreign key, so the order doesn't matter.
-- A category the user already gave a tax line keeps it.
-- -----------------------------------------------------------------------------
update app.ledger_account a
   set tax_line_code = case a.name when 'Interest income' then 'US_SCH_B_L1' else 'US_SCH_B_L5' end,
       updated_at = now()
  from app.entity e
 where e.workspace_id = a.workspace_id and e.id = a.entity_id and e.type = 'personal'
   and a.is_category and a.type = 'income' and a.tax_line_code is null
   and a.name in ('Interest income', 'Dividends');
