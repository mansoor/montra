-- Category management (ACC-08..12; ADR-0040). Categories are already ledger accounts with `is_category`, a group and
-- `archived_at`, so adding, renaming and archiving them needs no new columns. This migration only adds the
-- "Miscellaneous" category (ACC-12) to the personal books that exist; new ones get it from the chart template.

-- ---------------------------------------------------------------------------------------------
-- ACC-12: "Miscellaneous" in a personal entity's Daily living group, after its other categories, unless a category of
-- that name is already there (whatever its case, archived or not). Running it again adds nothing.
-- ---------------------------------------------------------------------------------------------
create function app.add_miscellaneous_category(p_workspace uuid, p_entity uuid) returns integer
  language plpgsql
  set search_path = pg_catalog
as $$
declare
  n integer;
begin
  insert into app.ledger_account (workspace_id, entity_id, type, subtype, name, currency, is_category,
                                  category_group_id, sort_order)
  select e.workspace_id, e.id, 'expense', 'category', 'Miscellaneous', e.functional_currency, true,
         g.id,
         coalesce((select max(a.sort_order) + 1 from app.ledger_account a
                    where a.workspace_id = e.workspace_id and a.entity_id = e.id
                      and a.category_group_id is not distinct from g.id and a.is_category), 0)
    from app.entity e
    left join lateral (select cg.id from app.category_group cg
                        where cg.workspace_id = e.workspace_id and cg.entity_id = e.id and cg.kind = 'daily'
                        order by cg.sort_order, cg.created_at limit 1) g on true
   where e.workspace_id = p_workspace and e.id = p_entity and e.type = 'personal'
     and not exists (select 1 from app.ledger_account a
                      where a.workspace_id = e.workspace_id and a.entity_id = e.id and a.is_category
                        and lower(a.name) = 'miscellaneous');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function app.add_miscellaneous_category(uuid, uuid) from public;
grant execute on function app.add_miscellaneous_category(uuid, uuid) to montra_app;

select app.add_miscellaneous_category(e.workspace_id, e.id) from app.entity e where e.type = 'personal';
