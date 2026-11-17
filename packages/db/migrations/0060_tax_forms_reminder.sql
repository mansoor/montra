-- Tax forms received, PR 5 (ADR-0052 §7.3, §8.5, §11; TAX-07, TAX-08, TAX-10): the reminder's notification type, a
-- file kind of their own for tax forms, their files' retention, purging forms from the Trash, and the count of forms a
-- tax package leaves out. The number was reserved by 0059; the runner applies unrecorded versions in order, so this
-- runs after 0061 and 0062 on databases that have them, and touches nothing they do.
--
-- Written to be run again harmlessly (the tests re-run it to check the data update).

-- -----------------------------------------------------------------------------
-- §11: one reminder on 16 February listing the expected forms that haven't come. Preferences are a JSON map per person
-- with defaults in the API, so the type needs no rows of its own.
-- -----------------------------------------------------------------------------
alter table app.notification drop constraint notification_type_check;
alter table app.notification add constraint notification_type_check
  check (type in ('bill_due', 'low_balance', 'overspend_pace', 'large_transaction',
                  'rent_overdue', 'lease_expiring', 'import_reminder', 'monthly_review', 'tax_due', 'reminder',
                  'suggestion', 'weekly_digest', 'backup_ready', 'storage_failing', 'ai_allowance',
                  'tax_forms_missing'));

-- -----------------------------------------------------------------------------
-- Tax forms are their own kind of file (PR 3 stored them as `other`), so the owner's own storage (ADR-0031) can leave
-- them out. Copied by default, as payslips are: the storage is the owner's, and the owner can read every form.
-- -----------------------------------------------------------------------------
alter table app.file drop constraint file_kind_check;
alter table app.file add constraint file_kind_check
  check (kind in ('statement', 'receipt', 'payslip', 'lease', 'invoice', 'export', 'other', 'logo', 'tax_form'));

alter table app.storage_destination drop constraint storage_destination_file_kinds_check;
alter table app.storage_destination add constraint storage_destination_file_kinds_check
  check (file_kinds <@ array['statement', 'receipt', 'payslip', 'lease', 'invoice', 'other', 'tax_form']);
alter table app.storage_destination alter column file_kinds
  set default array['statement', 'receipt', 'payslip', 'lease', 'invoice', 'other', 'tax_form'];

-- A connection that copied `other` files was copying tax forms; it goes on doing so under their own kind. One that
-- left `other` out wasn't, and still doesn't.
update app.storage_destination
   set file_kinds = array_append(file_kinds, 'tax_form'), updated_at = now()
 where 'other' = any (file_kinds) and not ('tax_form' = any (file_kinds));

-- The files tax forms already hold, and only those.
update app.file f
   set kind = 'tax_form'
 where f.kind = 'other'
   and exists (select 1 from app.tax_form t where t.workspace_id = f.workspace_id and f.id = any (t.file_ids));

-- -----------------------------------------------------------------------------
-- §8.5: a form's files are kept until 31 December of the tax year + 7, the receipts' default (RCP-10), then purged by
-- the retention job; the form and its boxes stay. A file holding several forms follows the latest year among them.
-- Kept in step by a trigger, since the year can change after upload (the reading, or a person, corrects it).
-- -----------------------------------------------------------------------------
create or replace function app.tax_form_file_retention() returns trigger
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
begin
  update app.file f
     set retain_until = make_date(y.tax_year + 7, 12, 31)
    from (select max(t.tax_year)::int as tax_year, fid
            from app.tax_form t, unnest(t.file_ids) as fid
           where t.workspace_id = new.workspace_id and t.file_ids && new.file_ids
           group by fid) y
   where f.workspace_id = new.workspace_id and f.id = y.fid and f.id = any (new.file_ids)
     and f.retain_until is distinct from make_date(y.tax_year + 7, 12, 31);
  return null;
end $$;
revoke all on function app.tax_form_file_retention() from public;
drop trigger if exists tax_form_file_retention on app.tax_form;
create trigger tax_form_file_retention after insert or update of tax_year, file_ids on app.tax_form
  for each row when (cardinality(new.file_ids) > 0) execute function app.tax_form_file_retention();

update app.file f
   set retain_until = make_date(y.tax_year + 7, 12, 31)
  from (select t.workspace_id, fid, max(t.tax_year)::int as tax_year
          from app.tax_form t, unnest(t.file_ids) as fid
         group by t.workspace_id, fid) y
 where f.workspace_id = y.workspace_id and f.id = y.fid
   and f.retain_until is distinct from make_date(y.tax_year + 7, 12, 31);

-- -----------------------------------------------------------------------------
-- §8.5: a form deleted 30 days ago goes for good with its targets, and its files once no other form holds them. The
-- files are marked deleted as of the form's deletion, so the same retention run removes them from storage too.
-- -----------------------------------------------------------------------------
create or replace function app.purge_trash() returns integer
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare n integer := 0; r record;
begin
  for r in select t.workspace_id, t.id from app.transaction t
            where t.deleted_at < now() - interval '30 days'
              and not exists (select 1 from app.journal_entry e
                               where e.workspace_id = t.workspace_id and e.transaction_id = t.id) loop
    begin
      delete from app.transaction where workspace_id = r.workspace_id and id = r.id;
      n := n + 1;
    exception when foreign_key_violation then
      null; -- Something still refers to it (a receipt, say); it stays in the trash for now.
    end;
  end loop;
  for r in select t.workspace_id, t.id, t.file_ids, t.deleted_at from app.tax_form t
            where t.deleted_at < now() - interval '30 days' loop
    delete from app.tax_form where workspace_id = r.workspace_id and id = r.id;
    update app.file f set deleted_at = r.deleted_at
     where f.workspace_id = r.workspace_id and f.id = any (r.file_ids) and f.deleted_at is null
       and not exists (select 1 from app.tax_form o where o.workspace_id = r.workspace_id and f.id = any (o.file_ids));
    n := n + 1;
  end loop;
  return n;
end $$;

-- -----------------------------------------------------------------------------
-- §7.3: the tax package counts the forms it leaves out ("2 forms not included: you can't see them"). This is every
-- form in the books and year, for someone who can read the books; the API takes away those the maker's row-level
-- security shows them. Nothing about the forms themselves, only how many.
-- -----------------------------------------------------------------------------
create or replace function app.tax_forms_in_books(p_entity uuid, p_year integer) returns integer
  language sql stable security definer set search_path = app, pg_temp as $$
  select case when app.can_read_entity(p_entity) then
    (select count(*)::integer from app.tax_form t
      where t.workspace_id = app.current_workspace_id() and t.entity_id = p_entity and t.tax_year = p_year
        and t.deleted_at is null and t.status not in ('dismissed', 'superseded'))
  else 0 end
$$;
revoke all on function app.tax_forms_in_books(uuid, integer) from public;
grant execute on function app.tax_forms_in_books(uuid, integer) to montra_app;
