-- BIZ-26: a business's tax account numbers (EIN, EDD employer account, FTB entity ID, CDTFA seller's permit) are sealed
-- at rest with the app's field encryption, as payroll's personal data is (ADR-0034 §3, ADR-0037 §5 as amended).
--
--   1. Each number gets a sealed column (`*_enc`, AES-GCM under the workspace's data key, bound to the workspace and the
--      column) and its last four in the clear (`*_last4`), for the masked display. The API writes only these from now
--      on, and clears the plain column in the same update.
--   2. The plain columns stay for now (expand step): the key is in the app, so SQL can't seal what's there. The worker's
--      `business.seal_tax_ids` job seals and clears them in batches, acting as each workspace's owner, and is queued
--      at every worker start; `app.tax_ids_to_seal()` lists what's left. A later contract migration drops them.
--   3. The audit trigger redacts these columns, plain and sealed, as it already redacts every `*_enc` column, so neither
--      the job nor an edit writes a full number into the audit log. Numbers already in the log are redacted below.
--   4. `payroll_settings.ein` and `ca_employer_account` have been unread since 0037 (the business's copy is the one
--      used); their stale plain copies are cleared.
--
-- Additive for old API tasks during a deploy: they still read and write the plain columns, which stay. A number an old
-- task writes is sealed by the job's next run. `issuer_ein` on tax forms is a payer's EIN, printed on every form they
-- send and used to match forms; it stays as it is (see docs/STATUS.md §7g).

alter table app.business_profile
  add column ein_enc                   bytea,
  add column ein_last4                 text check (ein_last4 ~ '^[0-9]{4}$'),
  add column ftb_entity_id_enc         bytea,
  add column ftb_entity_id_last4       text check (length(ftb_entity_id_last4) between 1 and 4),
  add column ca_employer_account_enc   bytea,
  add column ca_employer_account_last4 text check (ca_employer_account_last4 ~ '^[0-9]{4}$'),
  add column cdtfa_permit_enc          bytea,
  add column cdtfa_permit_last4        text check (length(cdtfa_permit_last4) between 1 and 4);

comment on column app.business_profile.ein is 'Unwritten since 0089: sealed in ein_enc. Cleared by business.seal_tax_ids.';
comment on column app.business_profile.ftb_entity_id is
  'Unwritten since 0089: sealed in ftb_entity_id_enc. Cleared by business.seal_tax_ids.';
comment on column app.business_profile.ca_employer_account is
  'Unwritten since 0089: sealed in ca_employer_account_enc. Cleared by business.seal_tax_ids.';
comment on column app.business_profile.cdtfa_permit is
  'Unwritten since 0089: sealed in cdtfa_permit_enc. Cleared by business.seal_tax_ids.';

-- -----------------------------------------------------------------------------
-- The audit trail: as 0020, and the tax account numbers are redacted like any `*_enc` column.
-- -----------------------------------------------------------------------------
-- Plain columns that hold a secret the audit trail mustn't copy (BIZ-26).
create function app.audit_secret(p_table text, p_column text) returns boolean
  language sql immutable set search_path = app, pg_temp as $$
  select p_table in ('business_profile', 'payroll_settings')
     and p_column in ('ein', 'ftb_entity_id', 'ca_employer_account', 'cdtfa_permit')
$$;
revoke all on function app.audit_secret(text, text) from public;

create or replace function app.audit_row() returns trigger
  language plpgsql security definer set search_path = app, pg_temp as $$
declare o jsonb; n jsonb; d jsonb; k text;
begin
  o := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  if tg_op = 'UPDATE' then
    d := '{}';
    for k in select jsonb_object_keys(n) loop
      if k not in ('updated_at', 'version', 'field_clock', 'search') and (o -> k) is distinct from (n -> k) then
        d := d || jsonb_build_object(k, case when k like '%\_enc' or app.audit_secret(tg_table_name, k)
                                             then '"[redacted]"'::jsonb
                                             else jsonb_build_array(o -> k, n -> k) end);
      end if;
    end loop;
    if d = '{}' then return null; end if;
  else
    d := coalesce(n, o) - 'field_clock' - 'search';
    for k in select jsonb_object_keys(d) loop
      if k like '%\_enc' or (app.audit_secret(tg_table_name, k) and d -> k <> 'null'::jsonb) then
        d := d || jsonb_build_object(k, '[redacted]'::text);
      end if;
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

-- Numbers already in the trail, from edits and from 0037's copy: the key stays, so the entry still says what changed.
update app.audit_log a
   set diff = a.diff || (select jsonb_object_agg(k, '[redacted]'::text)
                           from unnest(array['ein', 'ftb_entity_id', 'ca_employer_account', 'cdtfa_permit']) k
                          where a.diff ? k and a.diff -> k <> 'null'::jsonb)
 where a.subject_type in ('business_profile', 'payroll_settings')
   and exists (select 1 from unnest(array['ein', 'ftb_entity_id', 'ca_employer_account', 'cdtfa_permit']) k
                where a.diff ? k and a.diff -> k <> 'null'::jsonb);

-- Payroll's old copies, unread since 0037. The business's own number is the one kept, and sealed.
update app.payroll_settings set ein = null, ca_employer_account = null
 where ein is not null or ca_employer_account is not null;

-- -----------------------------------------------------------------------------
-- What the sealing job has left: a business with a plain number, and a member to act as (an owner, else an admin).
-- Null when the workspace has neither; the job skips those and reports how many.
-- -----------------------------------------------------------------------------
create function app.tax_ids_to_seal(p_limit int)
  returns table (workspace_id uuid, entity_id uuid, user_id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select * from (
    select b.workspace_id, b.entity_id,
           (select m.user_id from app.workspace_member m
             where m.workspace_id = b.workspace_id and m.role in ('owner', 'admin') and m.status = 'active'
             order by (m.role = 'owner') desc, m.user_id limit 1) as user_id
      from app.business_profile b
     where b.ein is not null or b.ftb_entity_id is not null or b.ca_employer_account is not null
        or b.cdtfa_permit is not null) t
   order by t.user_id is null, t.workspace_id, t.entity_id
   limit greatest(p_limit, 1)
$$;
revoke all on function app.tax_ids_to_seal(int) from public;
grant execute on function app.tax_ids_to_seal(int) to montra_app;
