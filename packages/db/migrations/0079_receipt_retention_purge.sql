-- RCP-10, BAK-09: receipts and stored files past their retention date go, once a workspace owner approves. The hourly
-- retention job (`data.retention`) already removed a file past its date on its own, but never the receipt: its lines,
-- OCR text and extraction stayed, pointing at a file that was gone. The owner decided (2026-11-22) that nothing past its
-- date is deleted without an owner's approval. Now:
--
--   1. The job finds what is past its date and records it here, per workspace, as waiting (`app.retention_item`). Each
--      owner is told once per new set (notification type `retention_due`).
--   2. An owner, on the web, approves exactly the items listed (with a recent sign-in), or keeps some or all for longer.
--   3. The job purges what was approved: a receipt with its lines and extracted text, then its files, then the bytes.
--
-- What stays: the transaction a receipt was matched to, and its postings. A posting split from a receipt line loses
-- only its pointer to the line (the foreign key sets it null), even in a closed or reconciled period: the amounts,
-- accounts and categories don't change, so the books are as they were (owner's decision, 2026-11-22; ADR-0014 §6).
--
-- What blocks a purge, approved or not: a legal hold (ADR-0049 §4) on any active member of the workspace. A file a
-- receipt still holds goes with that receipt, not on its own. A file another record needs by foreign key stays, as
-- before.
--
-- Where the bytes are (ADR-0031, ADR-0054 §10): Montra removes only its own object, and only when no other file row
-- names it. The owner's own storage and the household's vault keep their copies unless the owner asked for them to go
-- too; the existing trigger on `app.file` deletes does that, unchanged. A file held only in the vault has no object
-- here, so only its row goes.
--
-- Files from the Trash (30 days after a tax form was deleted for good, ADR-0052 §8.5) still go on their own: someone
-- already deleted them.
--
-- Written so old API tasks still running during a deploy keep working: `retention_due()` keeps its shape and only
-- stops listing files, so an old task deletes none; `purge_file` stays for those old tasks.

-- -----------------------------------------------------------------------------
-- The notification
-- -----------------------------------------------------------------------------
alter table app.notification drop constraint notification_type_check;
alter table app.notification add constraint notification_type_check
  check (type in ('bill_due', 'low_balance', 'overspend_pace', 'large_transaction',
                  'rent_overdue', 'lease_expiring', 'import_reminder', 'monthly_review', 'tax_due', 'reminder',
                  'suggestion', 'weekly_digest', 'backup_ready', 'storage_failing', 'ai_allowance',
                  'tax_forms_missing', 'vault_attention', 'files_missing', 'bank_feed_attention', 'retention_due'));

-- -----------------------------------------------------------------------------
-- Holds
-- -----------------------------------------------------------------------------

-- A legal hold on any active member keeps the whole workspace as it is: nothing in it ages out meanwhile.
create function app.workspace_on_legal_hold(p_workspace uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.workspace_member m
                   join app.account_suspension s on s.user_id = m.user_id and s.kind = 'legal_hold'
                  where m.workspace_id = p_workspace and m.status = 'active')
$$;
revoke all on function app.workspace_on_legal_hold(uuid) from public;

-- Whether a file has to stay although its date has passed: a legal hold, a receipt that still holds it (the file goes
-- with the receipt), or a record that needs it by foreign key (a statement's import, an invoice as sent, a logo).
create function app.file_retention_held(p_workspace uuid, p_file uuid) returns boolean
  language sql stable security definer set search_path = app, pg_temp as $$
  select app.workspace_on_legal_hold(p_workspace)
      or exists (select 1 from app.receipt r where r.workspace_id = p_workspace and p_file = any (r.attachment_ids))
      or exists (select 1 from app.import_batch b where b.workspace_id = p_workspace and b.file_id = p_file)
      or exists (select 1 from app.invoice v where v.workspace_id = p_workspace and v.pdf_file_id = p_file)
      or exists (select 1 from app.business_profile p where p.workspace_id = p_workspace and p.logo_file_id = p_file)
$$;
revoke all on function app.file_retention_held(uuid, uuid) from public;

-- -----------------------------------------------------------------------------
-- What is waiting for an owner. Only owners see it; only the functions below write it.
-- -----------------------------------------------------------------------------
create table app.retention_item (
  workspace_id  uuid not null references app.workspace (id) on delete cascade,
  kind          text not null check (kind in ('receipt', 'file')),
  subject_id    uuid not null,
  retain_until  date not null,
  found_at      timestamptz not null default now(),
  -- Who approved deleting it, and when. Purged by the next run after that, unless a legal hold stops it.
  approved_at   timestamptz,
  approved_by   uuid references app.app_user (id),
  primary key (workspace_id, kind, subject_id),
  check ((approved_at is null) = (approved_by is null))
);
create index retention_item_approved on app.retention_item (approved_at) where approved_at is not null;
alter table app.retention_item enable row level security;
alter table app.retention_item force row level security;
create policy retention_item_select on app.retention_item for select
  using (workspace_id = app.current_workspace_id() and app.current_member_role() = 'owner');
grant select on app.retention_item to montra_app;

create index receipt_retention on app.receipt (retain_until);

-- The job's first step: forgets items no longer past their date (kept for longer, or gone), then records up to p_limit
-- new ones, oldest first, skipping workspaces under a legal hold. Returns each active owner of a workspace that has new
-- items, with how many are new and how many are waiting, for the notification.
create function app.retention_find(p_limit integer)
  returns table (workspace_id uuid, user_id uuid, new_items integer, waiting integer)
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
#variable_conflict use_column
begin
  delete from app.retention_item i
   where i.kind = 'receipt'
     and not exists (select 1 from app.receipt r
                      where r.workspace_id = i.workspace_id and r.id = i.subject_id and r.retain_until < current_date);
  delete from app.retention_item i
   where i.kind = 'file'
     and not exists (select 1 from app.file f
                      where f.workspace_id = i.workspace_id and f.id = i.subject_id and f.retain_until < current_date);
  return query
  with due as (
    select r.workspace_id, 'receipt'::text as kind, r.id, r.retain_until from app.receipt r
     where r.retain_until < current_date
       and not exists (select 1 from app.retention_item i
                        where i.workspace_id = r.workspace_id and i.kind = 'receipt' and i.subject_id = r.id)
       and not app.workspace_on_legal_hold(r.workspace_id)
    union all
    select f.workspace_id, 'file', f.id, f.retain_until from app.file f
     where f.retain_until < current_date
       and not exists (select 1 from app.retention_item i
                        where i.workspace_id = f.workspace_id and i.kind = 'file' and i.subject_id = f.id)
       and not app.file_retention_held(f.workspace_id, f.id)
  ), added as (
    insert into app.retention_item (workspace_id, kind, subject_id, retain_until)
    select d.workspace_id, d.kind, d.id, d.retain_until from due d
     order by d.retain_until, d.workspace_id, d.id
     limit greatest(p_limit, 0)
    on conflict do nothing
    returning retention_item.workspace_id
  ), counted as (
    select a.workspace_id, count(*)::integer as n from added a group by a.workspace_id
  )
  select c.workspace_id, m.user_id, c.n,
         (c.n + (select count(*)::integer from app.retention_item w
                      where w.workspace_id = c.workspace_id and w.approved_at is null))
    from counted c
    join app.workspace_member m on m.workspace_id = c.workspace_id and m.role = 'owner' and m.status = 'active';
end $$;
revoke all on function app.retention_find(integer) from public;
grant execute on function app.retention_find(integer) to montra_app;

-- -----------------------------------------------------------------------------
-- The owner's review (the API's `retention` routes). Each answers for the current workspace's owners only.
-- -----------------------------------------------------------------------------
create function app.require_workspace_owner() returns void
  language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  if app.current_workspace_id() is null or app.current_member_role() is distinct from 'owner' then
    raise exception 'only an owner can review what is past its retention date' using errcode = 'insufficient_privilege';
  end if;
end $$;
revoke all on function app.require_workspace_owner() from public;

-- What is waiting, with what a person needs to decide: the merchant or file name, the date and amount, the transaction
-- a receipt belongs to, and whether it is already approved.
create function app.retention_review()
  returns table (kind text, subject_id uuid, retain_until date, title text, file_kind text, receipt_date date,
                 total_minor bigint, currency text, transaction_id uuid, transaction_date date, transaction_payee text,
                 found_at timestamptz, approved_at timestamptz)
  language plpgsql stable security definer set search_path = app, pg_temp as $$
#variable_conflict use_column
begin
  perform app.require_workspace_owner();
  return query
  select i.kind, i.subject_id, coalesce(r.retain_until, f.retain_until),
         case when i.kind = 'receipt' then coalesce(r.merchant, r.merchant_raw, 'Receipt') else f.file_name end,
         f.kind, r.receipt_date, r.total_minor, r.currency::text, t.id, t.txn_date,
         coalesce(t.payee_raw, nullif(t.description, '')), i.found_at, i.approved_at
    from app.retention_item i
    left join app.receipt r on i.kind = 'receipt' and r.workspace_id = i.workspace_id and r.id = i.subject_id
    left join app.file f on i.kind = 'file' and f.workspace_id = i.workspace_id and f.id = i.subject_id
    left join app.transaction t on t.workspace_id = r.workspace_id and t.id = r.transaction_id
   where i.workspace_id = app.current_workspace_id()
     and coalesce(r.retain_until, f.retain_until) < current_date
   order by 3, 4, 2;
end $$;
revoke all on function app.retention_review() from public;
grant execute on function app.retention_review() to montra_app;

-- Approves deleting exactly these items, and nothing found later. Only items still waiting and still past their date
-- count. Logged with who approved; returns how many.
create function app.retention_approve(p_kinds text[], p_ids uuid[]) returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare n integer; items jsonb;
begin
  perform app.require_workspace_owner();
  with picked as (
    update app.retention_item i set approved_at = now(), approved_by = app.current_user_id()
      from unnest(p_kinds, p_ids) as x(kind, id)
     where i.workspace_id = app.current_workspace_id() and i.kind = x.kind and i.subject_id = x.id
       and i.approved_at is null
       and (exists (select 1 from app.receipt r
                     where i.kind = 'receipt' and r.workspace_id = i.workspace_id and r.id = i.subject_id
                       and r.retain_until < current_date)
         or exists (select 1 from app.file f
                     where i.kind = 'file' and f.workspace_id = i.workspace_id and f.id = i.subject_id
                       and f.retain_until < current_date))
    returning i.kind, i.subject_id
  )
  select count(*)::integer, coalesce(jsonb_agg(jsonb_build_object('kind', p.kind, 'id', p.subject_id)), '[]')
    into n, items from picked p;
  if n > 0 then
    insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
    values (app.current_workspace_id(), app.current_user_id(), 'user', 'retention.approved', 'workspace',
            app.current_workspace_id()::text, jsonb_build_object('count', n, 'items', items));
  end if;
  return n;
end $$;
revoke all on function app.retention_approve(text[], uuid[]) from public;
grant execute on function app.retention_approve(text[], uuid[]) to montra_app;

-- Keeps these items for longer: their date moves to p_years from today, and they leave the list (approved or not).
-- Logged with who did it; returns how many.
create function app.retention_extend(p_kinds text[], p_ids uuid[], p_years integer) returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare n integer; items jsonb; v_until date := (current_date + make_interval(years => p_years))::date;
begin
  perform app.require_workspace_owner();
  if p_years is null or p_years not between 1 and 100 then
    raise exception 'keep for 1 to 100 years' using errcode = 'invalid_parameter_value';
  end if;
  with picked as (
    delete from app.retention_item i
     using unnest(p_kinds, p_ids) as x(kind, id)
     where i.workspace_id = app.current_workspace_id() and i.kind = x.kind and i.subject_id = x.id
    returning i.kind, i.subject_id
  ), receipts as (
    update app.receipt r set retain_until = v_until
      from picked p
     where p.kind = 'receipt' and r.workspace_id = app.current_workspace_id() and r.id = p.subject_id
       and r.retain_until < v_until
    returning r.id
  ), files as (
    update app.file f set retain_until = v_until
      from picked p
     where p.kind = 'file' and f.workspace_id = app.current_workspace_id() and f.id = p.subject_id
       and (f.retain_until is null or f.retain_until < v_until)
    returning f.id
  )
  select count(*)::integer, coalesce(jsonb_agg(jsonb_build_object('kind', p.kind, 'id', p.subject_id)), '[]')
    into n, items
    from picked p;
  if n > 0 then
    insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
    values (app.current_workspace_id(), app.current_user_id(), 'user', 'retention.extended', 'workspace',
            app.current_workspace_id()::text,
            jsonb_build_object('count', n, 'years', p_years, 'retainUntil', v_until, 'items', items));
  end if;
  return n;
end $$;
revoke all on function app.retention_extend(text[], uuid[], integer) from public;
grant execute on function app.retention_extend(text[], uuid[], integer) to montra_app;

-- -----------------------------------------------------------------------------
-- Purging what was approved
-- -----------------------------------------------------------------------------

-- Approved receipts still past their date and not under a legal hold, oldest approval first, at most p_limit.
create function app.retention_receipts_approved(p_limit integer)
  returns table (workspace_id uuid, id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select i.workspace_id, i.subject_id from app.retention_item i
   where i.kind = 'receipt' and i.approved_at is not null
     and exists (select 1 from app.receipt r
                  where r.workspace_id = i.workspace_id and r.id = i.subject_id and r.retain_until < current_date)
     and not app.workspace_on_legal_hold(i.workspace_id)
   order by i.approved_at, i.workspace_id, i.subject_id
   limit greatest(p_limit, 0)
$$;
revoke all on function app.retention_receipts_approved(integer) from public;
grant execute on function app.retention_receipts_approved(integer) to montra_app;

-- Removes one approved receipt past its date, with its lines, OCR text and extraction. Refused (false) for one not
-- approved, not due, or under a legal hold. Its earlier audit entries keep who and when but lose their contents, which
-- held the same extracted data; one entry says it was purged and who approved it. Its files take its date and its
-- approval, unless another receipt holds them, and go next.
create function app.purge_receipt(p_workspace uuid, p_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare r record; v_at timestamptz; v_by uuid;
begin
  select i.approved_at, i.approved_by into v_at, v_by from app.retention_item i
   where i.workspace_id = p_workspace and i.kind = 'receipt' and i.subject_id = p_id and i.approved_at is not null;
  if not found or app.workspace_on_legal_hold(p_workspace) then
    return false;
  end if;
  select x.retain_until, x.attachment_ids, x.transaction_id, x.deleted_at into r
    from app.receipt x
   where x.workspace_id = p_workspace and x.id = p_id and x.retain_until < current_date
     for update;
  if not found then
    return false;
  end if;
  perform set_config('app.actor_type', 'system', true);
  -- The lines' postings only lose their pointer to the line, in a locked period too (see the top of this file).
  perform set_config('app.allow_locked_edit', 'on', true);
  delete from app.receipt where workspace_id = p_workspace and id = p_id;
  perform set_config('app.allow_locked_edit', '', true);
  delete from app.retention_item where workspace_id = p_workspace and kind = 'receipt' and subject_id = p_id;

  update app.file f set retain_until = r.retain_until
   where f.workspace_id = p_workspace and f.id = any (r.attachment_ids)
     and (f.retain_until is null or f.retain_until > r.retain_until)
     and not exists (select 1 from app.receipt o
                      where o.workspace_id = p_workspace and f.id = any (o.attachment_ids));
  insert into app.retention_item (workspace_id, kind, subject_id, retain_until, approved_at, approved_by)
  select f.workspace_id, 'file', f.id, f.retain_until, v_at, v_by from app.file f
   where f.workspace_id = p_workspace and f.id = any (r.attachment_ids) and f.retain_until < current_date
     and not exists (select 1 from app.receipt o
                      where o.workspace_id = p_workspace and f.id = any (o.attachment_ids))
  on conflict (workspace_id, kind, subject_id)
    do update set approved_at = excluded.approved_at, approved_by = excluded.approved_by;

  update app.audit_log set diff = jsonb_build_object('redacted', 'retention')
   where workspace_id = p_workspace and subject_type = 'receipt' and subject_id = p_id::text;
  insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
  values (p_workspace, null, 'system', 'receipt.purged', 'receipt', p_id::text,
          jsonb_build_object('reason', 'retention', 'retainUntil', r.retain_until, 'transactionId', r.transaction_id,
                             'files', cardinality(r.attachment_ids), 'wasInTrash', r.deleted_at is not null,
                             'approvedBy', v_by, 'approvedAt', v_at));
  return true;
end $$;
revoke all on function app.purge_receipt(uuid, uuid) from public;
grant execute on function app.purge_receipt(uuid, uuid) to montra_app;

-- Files to remove now, at most p_limit: approved ones still past their date, and ones 30 days in the Trash. Never one
-- under a legal hold or still held by a receipt.
create function app.retention_files_due(p_limit integer)
  returns table (workspace_id uuid, id uuid)
  language sql stable security definer set search_path = app, pg_temp as $$
  select f.workspace_id, f.id from app.file f
   where (f.deleted_at < now() - interval '30 days'
          or (f.retain_until < current_date
              and exists (select 1 from app.retention_item i
                           where i.workspace_id = f.workspace_id and i.kind = 'file' and i.subject_id = f.id
                             and i.approved_at is not null)))
     and not app.file_retention_held(f.workspace_id, f.id)
   order by coalesce(f.retain_until, f.deleted_at::date), f.workspace_id, f.id
   limit greatest(p_limit, 0)
$$;
revoke all on function app.retention_files_due(integer) from public;
grant execute on function app.retention_files_due(integer) to montra_app;

-- Removes one file's row and returns the objects in Montra's storage the caller then deletes: the file's own, and one
-- the vault's job had still to remove (ADR-0054 §5), each only when no other row of the workspace names it (a restored
-- backup copies files under keys of its own, so a key never crosses workspaces). Null when the file stays: not due,
-- not approved, held, or still needed by a record's foreign key (then, as before, its dates are cleared so it isn't
-- looked at again). An empty array for a file held only in the vault: its row goes, and the vault keeps its document.
create function app.purge_expired_file(p_workspace uuid, p_id uuid) returns text[]
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare f record; v_at timestamptz; v_by uuid; keys text[];
begin
  select i.approved_at, i.approved_by into v_at, v_by from app.retention_item i
   where i.workspace_id = p_workspace and i.kind = 'file' and i.subject_id = p_id and i.approved_at is not null;
  select x.storage_key, x.kind, x.location, x.retain_until, x.deleted_at into f
    from app.file x
   where x.workspace_id = p_workspace and x.id = p_id
     and (x.deleted_at < now() - interval '30 days' or (x.retain_until < current_date and v_at is not null))
     for update;
  if not found or app.file_retention_held(p_workspace, p_id) then
    return null;
  end if;
  select coalesce(array_agg(i.source_key), '{}') into keys from app.vault_item i
   where i.workspace_id = p_workspace and i.file_id = p_id
     and i.source_key is not null and i.source_removed_at is null;
  perform set_config('app.actor_type', 'system', true);
  begin
    delete from app.file where workspace_id = p_workspace and id = p_id;
  exception when foreign_key_violation then
    update app.file set deleted_at = null, retain_until = null where workspace_id = p_workspace and id = p_id;
    delete from app.retention_item where workspace_id = p_workspace and kind = 'file' and subject_id = p_id;
    return null;
  end;
  delete from app.retention_item where workspace_id = p_workspace and kind = 'file' and subject_id = p_id;
  insert into app.audit_log (workspace_id, actor_user_id, actor_type, action, subject_type, subject_id, diff)
  values (p_workspace, null, 'system', 'file.purged', 'file', p_id::text,
          jsonb_build_object('reason', case when f.deleted_at < now() - interval '30 days' then 'trash'
                                            else 'retention' end,
                             'kind', f.kind, 'location', f.location, 'retainUntil', f.retain_until,
                             'approvedBy', v_by, 'approvedAt', v_at));
  return array(
    select distinct k from unnest(array_append(keys, f.storage_key)) as k
     where k is not null
       and not exists (select 1 from app.file o where o.workspace_id = p_workspace and o.storage_key = k)
       and not exists (select 1 from app.vault_item i
                        where i.workspace_id = p_workspace and i.source_key = k and i.source_removed_at is null));
end $$;
revoke all on function app.purge_expired_file(uuid, uuid) from public;
grant execute on function app.purge_expired_file(uuid, uuid) to montra_app;

-- What else retention has to do. Files are no longer listed here: `retention_files_due` lists them in batches, and a
-- file past its date needs an owner's approval first.
create or replace function app.retention_due()
  returns table (kind text, workspace_id uuid, id uuid, storage_key text)
  language sql stable security definer set search_path = app, pg_temp as $$
  select 'export', e.workspace_id, e.id, e.storage_key from app.export_job e
   where e.status = 'ready' and e.expires_at < now()
  union all
  select 'restore', null::uuid, r.id, r.storage_key from app.restore_job r where r.expires_at < now()
  union all
  select 'workspace', w.id, w.id, null from app.workspace w where w.purge_after < now()
  union all
  select 'user', null::uuid, u.id, null from app.app_user u where u.purge_after < now()
$$;
